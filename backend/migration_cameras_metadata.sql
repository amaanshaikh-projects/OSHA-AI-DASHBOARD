-- Migration: Add ai_metadata column to cameras table
ALTER TABLE public.cameras 
ADD COLUMN IF NOT EXISTS ai_metadata JSONB DEFAULT NULL;
