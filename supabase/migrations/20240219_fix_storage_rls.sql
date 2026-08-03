-- Allow authenticated users to upload files to delivery-acts bucket
create policy "Allow Auth Uploads"
on storage.objects for insert
to authenticated
with check ( bucket_id = 'delivery-acts' );

-- Allow authenticated users to update their own files (if needed)
create policy "Allow Auth Updates"
on storage.objects for update
to authenticated
using ( bucket_id = 'delivery-acts' );

-- Allow authenticated users to read files
create policy "Allow Auth Read"
on storage.objects for select
to authenticated
using ( bucket_id = 'delivery-acts' );

-- Ensure catalog permissions
grant all on storage.objects to authenticated;
grant all on storage.buckets to authenticated;
