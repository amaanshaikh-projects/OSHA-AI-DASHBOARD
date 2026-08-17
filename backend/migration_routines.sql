-- Add routine_learning_enabled to cameras table
ALTER TABLE public.cameras
ADD COLUMN IF NOT EXISTS routine_learning_enabled BOOLEAN DEFAULT FALSE NOT NULL;

-- Create camera_routines table
CREATE TABLE IF NOT EXISTS public.camera_routines (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    camera_id UUID REFERENCES public.cameras ON DELETE CASCADE NOT NULL,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
    description TEXT NOT NULL,
    time_window TEXT, -- e.g., "14:00-15:00"
    day_of_week INTEGER, -- 0-6 or NULL for all days
    confidence INTEGER DEFAULT 0 NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.camera_routines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow users to view own routines" 
    ON public.camera_routines FOR SELECT 
    USING (auth.uid() = user_id);

CREATE POLICY "Allow users to insert own routines" 
    ON public.camera_routines FOR INSERT 
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Allow users to update own routines" 
    ON public.camera_routines FOR UPDATE 
    USING (auth.uid() = user_id);

CREATE POLICY "Allow users to delete own routines" 
    ON public.camera_routines FOR DELETE 
    USING (auth.uid() = user_id);
