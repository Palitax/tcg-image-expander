-- Supabase Schema & Row Level Security (RLS) Policies Setup

-- 1. Create Spaces Table
CREATE TABLE IF NOT EXISTS public.spaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    passcode VARCHAR(4) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS on Spaces
ALTER TABLE public.spaces ENABLE ROW LEVEL SECURITY;

-- Policies for Spaces
CREATE POLICY "Allow public select on spaces" ON public.spaces
    FOR SELECT TO public USING (true);

CREATE POLICY "Allow public insert on spaces" ON public.spaces
    FOR INSERT TO public WITH CHECK (true);


-- 2. Create Artworks Table
CREATE TABLE IF NOT EXISTS public.artworks (
    id VARCHAR(255) PRIMARY KEY,
    space_id UUID REFERENCES public.spaces(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    image_url TEXT NOT NULL,
    original_card_url TEXT,
    background_url TEXT,
    aspect_ratio TEXT NOT NULL,
    timestamp BIGINT NOT NULL
);

-- Enable RLS on Artworks
ALTER TABLE public.artworks ENABLE ROW LEVEL SECURITY;

-- Policies for Artworks
CREATE POLICY "Allow public select on artworks" ON public.artworks
    FOR SELECT TO public USING (true);

CREATE POLICY "Allow public insert on artworks" ON public.artworks
    FOR INSERT TO public WITH CHECK (true);

-- CRITICAL: Allow public update on artworks (REQUIRED for Renaming)
CREATE POLICY "Allow public update on artworks" ON public.artworks
    FOR UPDATE TO public USING (true) WITH CHECK (true);

CREATE POLICY "Allow public delete on artworks" ON public.artworks
    FOR DELETE TO public USING (true);
