-- 1. Create a table to track files that need to be deleted from storage
CREATE TABLE IF NOT EXISTS public.pending_storage_deletions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    file_path TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS (allow service role only)
ALTER TABLE public.pending_storage_deletions ENABLE ROW LEVEL SECURITY;

-- 2. Enable pg_cron extension (requires superuser privileges, available on Supabase)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 3. Create the cleanup function
CREATE OR REPLACE FUNCTION cleanup_old_alerts()
RETURNS void AS $$
DECLARE
    rec RECORD;
    extracted_name text;
BEGIN
    FOR rec IN 
        SELECT id, snapshot_url 
        FROM public.detections 
        WHERE created_at < NOW() - INTERVAL '48 hours'
    LOOP
        -- Extract object name from snapshot_url (e.g., 'camId/timestamp.jpg')
        IF rec.snapshot_url IS NOT NULL AND rec.snapshot_url NOT LIKE 'data:%' THEN
            extracted_name := substring(rec.snapshot_url from '/snapshots/(.+)$');
            
            IF extracted_name IS NOT NULL THEN
                -- Insert into pending deletions table for the Node worker to pick up
                INSERT INTO public.pending_storage_deletions (file_path) VALUES (extracted_name);
            END IF;
        END IF;

        -- Delete the detection record from the database
        DELETE FROM public.detections WHERE id = rec.id;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Schedule the cron job to run every hour
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup_old_alerts_job') THEN
    PERFORM cron.unschedule('cleanup_old_alerts_job');
  END IF;
END $$;

SELECT cron.schedule(
  'cleanup_old_alerts_job',
  '0 * * * *', -- Run at minute 0 past every hour
  $$SELECT cleanup_old_alerts();$$
);
