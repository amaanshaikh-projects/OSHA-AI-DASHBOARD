-- ==========================================================================
-- OSHA AI - Supabase Database Schema (Production Ready)
-- ==========================================================================

-- Disable constraints temporarily to drop if exists (useful for setup/reset)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();
DROP TABLE IF EXISTS public.notification_logs CASCADE;
DROP TABLE IF EXISTS public.detections CASCADE;
DROP TABLE IF EXISTS public.camera_prompts CASCADE;
DROP TABLE IF EXISTS public.cameras CASCADE;
DROP TABLE IF EXISTS public.subscriptions CASCADE;
DROP TABLE IF EXISTS public.settings CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;

-- 1. Profiles Table (References Auth.Users)
CREATE TABLE public.profiles (
    id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
    full_name TEXT,
    email TEXT NOT NULL,
    avatar_url TEXT,
    subscription_plan TEXT DEFAULT 'Free' NOT NULL,
    subscription_status TEXT DEFAULT 'Active' NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- RLS for profiles
CREATE POLICY "Allow users to view own profile" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Allow users to insert own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "Allow users to update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Prevent users from updating their own subscription_plan or subscription_status directly
REVOKE UPDATE (subscription_plan, subscription_status) ON public.profiles FROM authenticated;
REVOKE UPDATE (subscription_plan, subscription_status) ON public.profiles FROM anon;

-- 2. Subscriptions Table
CREATE TABLE public.subscriptions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
    plan_name TEXT DEFAULT 'Free' NOT NULL,
    subscription_status TEXT DEFAULT 'active' NOT NULL,
    billing_interval TEXT, -- 'monthly', 'yearly', or NULL for Free
    start_date TIMESTAMP WITH TIME ZONE,
    end_date TIMESTAMP WITH TIME ZONE,
    next_billing_date TIMESTAMP WITH TIME ZONE,
    payment_provider_subscription_id TEXT,
    latest_payment_date TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow users to view own subscription" 
    ON public.subscriptions FOR SELECT 
    USING (auth.uid() = user_id);
    
-- Users cannot manually insert or update subscriptions. Only backend service_role can.

-- 3. Settings Table
CREATE TABLE public.settings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL UNIQUE,
    timezone TEXT DEFAULT 'UTC' NOT NULL,
    theme TEXT DEFAULT 'light' NOT NULL,
    email_notifications BOOLEAN DEFAULT TRUE NOT NULL,
    notification_cooldown INTEGER DEFAULT 60 NOT NULL, -- Cooldown in seconds
    daily_summary BOOLEAN DEFAULT FALSE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow users to view own settings" 
    ON public.settings FOR SELECT 
    USING (auth.uid() = user_id);

CREATE POLICY "Allow users to update own settings" 
    ON public.settings FOR UPDATE 
    USING (auth.uid() = user_id);

-- 4. Cameras Table
CREATE TABLE public.cameras (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    location TEXT NOT NULL,
    rtsp_url TEXT NOT NULL,
    username TEXT,
    password_encrypted TEXT, -- Base64/Encrypted credentials
    status TEXT DEFAULT 'Online' NOT NULL, -- 'Online', 'Offline', 'Paused'
    connection_quality TEXT DEFAULT 'Excellent' NOT NULL, -- 'Excellent', 'Good', 'Fair', 'Poor'
    detection_interval INTEGER DEFAULT 5 NOT NULL, -- Interval in seconds
    monitoring_enabled BOOLEAN DEFAULT TRUE NOT NULL,
    activated_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    last_prompt_text TEXT,
    prompt_metadata JSONB,
    routine_learning_enabled BOOLEAN DEFAULT FALSE NOT NULL,
    camera_profile JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.cameras ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow users to select own cameras" 
    ON public.cameras FOR SELECT 
    USING (auth.uid() = user_id);

CREATE POLICY "Allow users to insert own cameras" 
    ON public.cameras FOR INSERT 
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Allow users to update own cameras" 
    ON public.cameras FOR UPDATE 
    USING (auth.uid() = user_id);

CREATE POLICY "Allow users to delete own cameras" 
    ON public.cameras FOR DELETE 
    USING (auth.uid() = user_id);

-- Enforce Camera Limits based on Subscription Plan
CREATE OR REPLACE FUNCTION check_camera_limit()
RETURNS TRIGGER AS $$
DECLARE
    plan TEXT;
    cam_count INTEGER;
    max_cams INTEGER;
BEGIN
    SELECT subscription_plan INTO plan FROM public.profiles WHERE id = NEW.user_id;
    SELECT count(*) INTO cam_count FROM public.cameras WHERE user_id = NEW.user_id;

    IF plan = 'Free' THEN
        max_cams := 1;
    ELSIF plan = 'Starter' THEN
        max_cams := 2;
    ELSIF plan = 'Pro' THEN
        max_cams := 5;
    ELSE
        max_cams := 999999; -- Enterprise
    END IF;

    IF cam_count >= max_cams THEN
        RAISE EXCEPTION 'Plan limit reached. Cannot add more cameras without upgrading.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_camera_limit
    BEFORE INSERT ON public.cameras
    FOR EACH ROW
    EXECUTE FUNCTION check_camera_limit();

-- 5. Camera Prompts Table (Tracks active & historical prompts for every camera)
CREATE TABLE public.camera_prompts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    camera_id UUID REFERENCES public.cameras ON DELETE CASCADE NOT NULL,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
    prompt_text TEXT NOT NULL,
    extracted_metadata JSONB DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.camera_prompts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow users to view own camera prompts" 
    ON public.camera_prompts FOR SELECT 
    USING (auth.uid() = user_id);

CREATE POLICY "Allow users to insert own camera prompts" 
    ON public.camera_prompts FOR INSERT 
    WITH CHECK (auth.uid() = user_id);

-- 5b. Camera Routines Table (Learned behaviors)
CREATE TABLE public.camera_routines (
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

-- 6. Detections (Vision AI Event Logs)
CREATE TABLE public.detections (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    camera_id UUID REFERENCES public.cameras ON DELETE CASCADE NOT NULL,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
    snapshot_url TEXT, -- Data URI or secure storage link
    metadata JSONB DEFAULT NULL,
    reason TEXT NOT NULL,
    confidence NUMERIC(5,2) NOT NULL, -- confidence level (e.g. 98.40)
    status TEXT DEFAULT 'Unread' NOT NULL, -- 'Unread', 'Read', 'Deleted'
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.detections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow users to view own detections" 
    ON public.detections FOR SELECT 
    USING (auth.uid() = user_id);

CREATE POLICY "Allow users to insert own detections" 
    ON public.detections FOR INSERT 
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Allow users to update own detections" 
    ON public.detections FOR UPDATE 
    USING (auth.uid() = user_id);

CREATE POLICY "Allow users to delete own detections" 
    ON public.detections FOR DELETE 
    USING (auth.uid() = user_id);

-- 7. Notification Logs Table (Tracks alerts delivered)
CREATE TABLE public.notification_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
    detection_id UUID REFERENCES public.detections ON DELETE CASCADE NOT NULL,
    type TEXT NOT NULL, -- 'Email', 'Slack', 'Webhook'
    status TEXT DEFAULT 'Sent' NOT NULL, -- 'Sent', 'Failed'
    sent_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.notification_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow users to view own notification logs" 
    ON public.notification_logs FOR SELECT 
    USING (auth.uid() = user_id);

CREATE POLICY "Allow users to insert own notification logs" 
    ON public.notification_logs FOR INSERT 
    WITH CHECK (auth.uid() = user_id);

-- Trigger to Automatically Create Profile & Settings on Signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
    INSERT INTO public.profiles (id, email, full_name, avatar_url, subscription_plan, subscription_status)
    VALUES (
        new.id,
        new.email,
        coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
        new.raw_user_meta_data->>'avatar_url',
        'Free',
        'Active'
    );
    
    INSERT INTO public.settings (user_id)
    VALUES (new.id);
    
    INSERT INTO public.subscriptions (user_id, plan_name, subscription_status)
    VALUES (new.id, 'Free', 'Active');
    
    RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Indexes for performance optimizations
CREATE INDEX IF NOT EXISTS idx_detections_timestamp ON public.detections(timestamp);
CREATE INDEX IF NOT EXISTS idx_detections_user_id ON public.detections(user_id);
CREATE INDEX IF NOT EXISTS idx_cameras_user_id ON public.cameras(user_id);

-- Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.detections;

