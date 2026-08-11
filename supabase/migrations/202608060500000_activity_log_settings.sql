CREATE TABLE public.activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  details JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Indexes
CREATE INDEX idx_activity_logs_user_id ON public.activity_logs(user_id);
CREATE INDEX idx_activity_logs_created_at ON public.activity_logs(created_at DESC);
CREATE INDEX idx_activity_logs_action ON public.activity_logs(action);

-- Enable RLS
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

-- Policy: Only admin can read logs
CREATE POLICY activity_logs_admin_read ON public.activity_logs
  FOR SELECT USING (
    EXISTS(
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Policy: System can insert logs
CREATE POLICY activity_logs_insert ON public.activity_logs
  FOR INSERT WITH CHECK (true);


CREATE TABLE public.company_settings (
  id TEXT PRIMARY KEY DEFAULT '1',
  company_name TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  matricule_fiscal TEXT,
  rc TEXT,
  ccb TEXT,
  footer_address TEXT,
  default_vat_rate NUMERIC(5,2) DEFAULT 20,
  fiscal_stamp NUMERIC(10,3) DEFAULT 0,
  logo_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.company_settings ENABLE ROW LEVEL SECURITY;

-- Policy: Only admin can read/write
CREATE POLICY company_settings_admin_all ON public.company_settings
  FOR ALL USING (
    EXISTS(
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Insert default row
INSERT INTO public.company_settings (id) VALUES ('1')
ON CONFLICT (id) DO NOTHING;