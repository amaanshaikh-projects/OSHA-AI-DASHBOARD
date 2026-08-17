-- Migration for Camera Zones
CREATE TABLE IF NOT EXISTS public.camera_zones (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    camera_id UUID REFERENCES public.cameras(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'polygon',
    coordinates JSONB NOT NULL,
    enabled BOOLEAN DEFAULT true,
    version INTEGER DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- RLS Policies
ALTER TABLE public.camera_zones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own zones" 
ON public.camera_zones FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own zones" 
ON public.camera_zones FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own zones" 
ON public.camera_zones FOR UPDATE 
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own zones" 
ON public.camera_zones FOR DELETE 
USING (auth.uid() = user_id);
