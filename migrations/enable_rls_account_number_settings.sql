-- Enable Row Level Security on account_number_settings table
ALTER TABLE IF EXISTS public.account_number_settings ENABLE ROW LEVEL SECURITY;

-- Create a policy that allows all operations (to match previous behavior but with RLS enabled)
-- You can restrict this later based on your requirements
DROP POLICY IF EXISTS "Allow all operations on account_number_settings" ON public.account_number_settings;

CREATE POLICY "Allow all operations on account_number_settings"
ON public.account_number_settings
FOR ALL
USING (true);
