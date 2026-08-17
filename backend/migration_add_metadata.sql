-- Migration: Add metadata column to detections table
ALTER TABLE public.detections 
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT NULL;
