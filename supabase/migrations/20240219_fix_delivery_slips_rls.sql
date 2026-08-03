-- Enable RLS on the table (if not already enabled)
alter table inventory_delivery_slips enable row level security;

-- Policy for INSERT: Authenticated users can create slips
create policy "Authenticated users can create delivery slips"
on inventory_delivery_slips for insert
to authenticated
with check (true);

-- Policy for SELECT: Authenticated users can view slips
create policy "Authenticated users can view delivery slips"
on inventory_delivery_slips for select
to authenticated
using (true);

-- Grant permissions to authenticated role just in case
grant all on inventory_delivery_slips to authenticated;
