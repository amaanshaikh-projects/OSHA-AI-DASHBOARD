-- migration_auto_tuning.sql
-- Add learned thresholds to the cameras table for 24-hour Auto-Tuning

ALTER TABLE public.cameras
ADD COLUMN IF NOT EXISTS learned_motion_threshold DOUBLE PRECISION DEFAULT NULL,
ADD COLUMN IF NOT EXISTS learned_lighting_baseline DOUBLE PRECISION DEFAULT NULL,
ADD COLUMN IF NOT EXISTS learned_confidence_threshold INTEGER DEFAULT NULL;

-- Ensure these columns are selectable via RLS (already covered by existing policies on cameras table)
