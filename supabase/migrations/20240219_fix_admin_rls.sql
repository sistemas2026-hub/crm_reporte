-- Policy for Admins to Update Any Asset
CREATE POLICY "Admins can update any asset"
ON "public"."inventory_assets"
AS PERMISSIVE
FOR UPDATE
TO authenticated
USING (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
    and profiles.role in ('admin', 'superadmin', 'almacen', 'supervisor')
  )
);

-- Policy for Admins to Insert Any Movement (e.g. Return from other user)
CREATE POLICY "Admins can insert any movement"
ON "public"."inventory_movements"
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
    and profiles.role in ('admin', 'superadmin', 'almacen', 'supervisor')
  )
);
