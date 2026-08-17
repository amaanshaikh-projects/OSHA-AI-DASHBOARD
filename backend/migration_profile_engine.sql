-- migration_profile_engine.sql
-- Drop the old individual threshold columns if they exist
ALTER TABLE public.cameras
DROP COLUMN IF EXISTS learned_motion_threshold,
DROP COLUMN IF EXISTS learned_lighting_baseline,
DROP COLUMN IF EXISTS learned_confidence_threshold;

-- Add the new JSONB profile column
ALTER TABLE public.cameras
ADD COLUMN IF NOT EXISTS camera_profile JSONB DEFAULT '{}'::jsonb;
