-- ==========================================================================
-- OSHA AI - pgvector Migration (AI Event Search)
-- ==========================================================================

-- 1. Enable the pgvector extension (Supabase comes with this pre-installed)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Add an embedding column and search_description to the detections table
ALTER TABLE public.detections
ADD COLUMN IF NOT EXISTS search_description TEXT,
ADD COLUMN IF NOT EXISTS embedding vector(384);

-- 3. Create a Postgres function for semantic search with Smart Filters
CREATE OR REPLACE FUNCTION match_detections(
  query_embedding vector(384),
  match_threshold float,
  match_count int,
  p_user_id uuid,
  p_camera_id uuid DEFAULT NULL,
  p_start_date timestamptz DEFAULT NULL,
  p_end_date timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  camera_id uuid,
  reason text,
  search_description text,
  confidence float,
  snapshot_url text,
  detected_at timestamptz,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    detections.id,
    detections.camera_id,
    detections.reason,
    detections.search_description,
    detections.confidence,
    detections.snapshot_url,
    detections.timestamp AS detected_at,
    1 - (detections.embedding <=> query_embedding) AS similarity
  FROM detections
  WHERE detections.user_id = p_user_id
    AND detections.embedding IS NOT NULL
    AND 1 - (detections.embedding <=> query_embedding) > match_threshold
    AND (p_camera_id IS NULL OR detections.camera_id = p_camera_id)
    AND (p_start_date IS NULL OR detections.timestamp >= p_start_date)
    AND (p_end_date IS NULL OR detections.timestamp <= p_end_date)
  ORDER BY detections.embedding <=> query_embedding
  LIMIT match_count;
$$;
