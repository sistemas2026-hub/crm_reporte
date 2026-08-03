-- Create a new public bucket for delivery acts
insert into storage.buckets (id, name, public)
values ('delivery-acts', 'delivery-acts', true)
on conflict (id) do nothing;

-- Set up access policies for the delivery-acts bucket

-- Allow authenticated users to upload files
create policy "Authenticated users can upload delivery acts"
on storage.objects for insert
to authenticated
with check ( bucket_id = 'delivery-acts' );

-- Allow public access to view files (needed for email links)
create policy "Public access to delivery acts"
on storage.objects for select
to public
using ( bucket_id = 'delivery-acts' );
