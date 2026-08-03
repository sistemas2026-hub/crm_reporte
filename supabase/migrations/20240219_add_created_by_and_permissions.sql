
-- Add created_by column to inventory_movements
ALTER TABLE public.inventory_movements 
ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id);

COMMENT ON COLUMN public.inventory_movements.created_by IS 'User who created the movement';

-- Add permissions column to profiles
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS permissions jsonb DEFAULT '{}'::jsonb;

-- Update RLS policies for inventory_movements
DROP POLICY IF EXISTS "Allow inventory management with permission" ON public.inventory_movements;

CREATE POLICY "Allow inventory management with permission" 
ON public.inventory_movements 
FOR INSERT TO authenticated 
WITH CHECK ( 
  (auth.uid() IN ( 
    SELECT id FROM profiles WHERE (permissions->'inventory'->>'can_manage')::boolean = true 
  )) 
);

-- Ensure authenticated users can select created_by
GRANT SELECT(created_by) ON public.inventory_movements TO authenticated;
GRANT INSERT(created_by) ON public.inventory_movements TO authenticated;

-- Force schema cache reload just in case
NOTIFY pgrst, 'reload config';
