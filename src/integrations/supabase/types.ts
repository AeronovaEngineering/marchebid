export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      activity_logs: {
        Row: {
          action: string
          created_at: string | null
          details: Json | null
          entity_id: string | null
          entity_type: string | null
          id: string
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string | null
          details?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string | null
          details?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bid_lignes: {
        Row: {
          id: string
          marche_ligne_id: string
          materiel_catalogue_id: string | null
          notes: string | null
          prix_fourniture: number | null
          prix_pose: number | null
          statut: Database["public"]["Enums"]["ligne_statut"] | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          marche_ligne_id: string
          materiel_catalogue_id?: string | null
          notes?: string | null
          prix_fourniture?: number | null
          prix_pose?: number | null
          statut?: Database["public"]["Enums"]["ligne_statut"] | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          marche_ligne_id?: string
          materiel_catalogue_id?: string | null
          notes?: string | null
          prix_fourniture?: number | null
          prix_pose?: number | null
          statut?: Database["public"]["Enums"]["ligne_statut"] | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_bid_lignes_marche_ligne"
            columns: ["marche_ligne_id"]
            isOneToOne: true
            referencedRelation: "marche_lignes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_bid_lignes_materiel_catalogue"
            columns: ["materiel_catalogue_id"]
            isOneToOne: false
            referencedRelation: "materiel_catalogue"
            referencedColumns: ["id"]
          },
        ]
      }
      catalogue_staging: {
        Row: {
          categorie: string | null
          created_at: string | null
          designation: string
          fournisseur_id: string | null
          id: string
          prix_fourniture: number | null
          sous_categorie: string | null
          specs: Json | null
          unite: string | null
        }
        Insert: {
          categorie?: string | null
          created_at?: string | null
          designation: string
          fournisseur_id?: string | null
          id?: string
          prix_fourniture?: number | null
          sous_categorie?: string | null
          specs?: Json | null
          unite?: string | null
        }
        Update: {
          categorie?: string | null
          created_at?: string | null
          designation?: string
          fournisseur_id?: string | null
          id?: string
          prix_fourniture?: number | null
          sous_categorie?: string | null
          specs?: Json | null
          unite?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_catalogue_staging_fournisseur"
            columns: ["fournisseur_id"]
            isOneToOne: false
            referencedRelation: "fournisseurs"
            referencedColumns: ["id"]
          },
        ]
      }
      chantiers: {
        Row: {
          client: string | null
          created_at: string | null
          created_by: string | null
          id: string
          lieu: string | null
          nom: string
          statut: Database["public"]["Enums"]["chantier_statut"] | null
        }
        Insert: {
          client?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          lieu?: string | null
          nom: string
          statut?: Database["public"]["Enums"]["chantier_statut"] | null
        }
        Update: {
          client?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          lieu?: string | null
          nom?: string
          statut?: Database["public"]["Enums"]["chantier_statut"] | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_chantiers_created_by"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      company_settings: {
        Row: {
          address: string | null
          ccb: string | null
          company_name: string | null
          created_at: string | null
          default_vat_rate: number | null
          email: string | null
          fiscal_stamp: number | null
          footer_address: string | null
          id: string
          logo_url: string | null
          matricule_fiscal: string | null
          phone: string | null
          rc: string | null
          updated_at: string | null
        }
        Insert: {
          address?: string | null
          ccb?: string | null
          company_name?: string | null
          created_at?: string | null
          default_vat_rate?: number | null
          email?: string | null
          fiscal_stamp?: number | null
          footer_address?: string | null
          id?: string
          logo_url?: string | null
          matricule_fiscal?: string | null
          phone?: string | null
          rc?: string | null
          updated_at?: string | null
        }
        Update: {
          address?: string | null
          ccb?: string | null
          company_name?: string | null
          created_at?: string | null
          default_vat_rate?: number | null
          email?: string | null
          fiscal_stamp?: number | null
          footer_address?: string | null
          id?: string
          logo_url?: string | null
          matricule_fiscal?: string | null
          phone?: string | null
          rc?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      fournisseurs: {
        Row: {
          contact: string | null
          created_at: string | null
          email: string | null
          id: string
          nom: string
          notes: string | null
          telephone: string | null
        }
        Insert: {
          contact?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          nom: string
          notes?: string | null
          telephone?: string | null
        }
        Update: {
          contact?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          nom?: string
          notes?: string | null
          telephone?: string | null
        }
        Relationships: []
      }
      marche_lignes: {
        Row: {
          a_pose: boolean | null
          chapitre_ou_zone: string | null
          designation: string
          id: string
          marche_id: string
          numero: string | null
          ordre: number | null
          quantite: number | null
          unite: string | null
        }
        Insert: {
          a_pose?: boolean | null
          chapitre_ou_zone?: string | null
          designation: string
          id?: string
          marche_id: string
          numero?: string | null
          ordre?: number | null
          quantite?: number | null
          unite?: string | null
        }
        Update: {
          a_pose?: boolean | null
          chapitre_ou_zone?: string | null
          designation?: string
          id?: string
          marche_id?: string
          numero?: string | null
          ordre?: number | null
          quantite?: number | null
          unite?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_marche_lignes_marche"
            columns: ["marche_id"]
            isOneToOne: false
            referencedRelation: "marches"
            referencedColumns: ["id"]
          },
        ]
      }
      marches: {
        Row: {
          chantier_id: string
          date_import: string | null
          fichier_original: string | null
          format_detecte: string | null
          id: string
          lot: string
        }
        Insert: {
          chantier_id: string
          date_import?: string | null
          fichier_original?: string | null
          format_detecte?: string | null
          id?: string
          lot: string
        }
        Update: {
          chantier_id?: string
          date_import?: string | null
          fichier_original?: string | null
          format_detecte?: string | null
          id?: string
          lot?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_marches_chantier"
            columns: ["chantier_id"]
            isOneToOne: false
            referencedRelation: "chantiers"
            referencedColumns: ["id"]
          },
        ]
      }
      materiel_catalogue: {
        Row: {
          categorie: string | null
          date_maj: string | null
          designation: string
          fournisseur_id: string | null
          id: string
          prix_fourniture: number | null
          sous_categorie: string | null
          specs: Json | null
          statut: Database["public"]["Enums"]["catalogue_statut"] | null
          unite: string
        }
        Insert: {
          categorie?: string | null
          date_maj?: string | null
          designation: string
          fournisseur_id?: string | null
          id?: string
          prix_fourniture?: number | null
          sous_categorie?: string | null
          specs?: Json | null
          statut?: Database["public"]["Enums"]["catalogue_statut"] | null
          unite: string
        }
        Update: {
          categorie?: string | null
          date_maj?: string | null
          designation?: string
          fournisseur_id?: string | null
          id?: string
          prix_fourniture?: number | null
          sous_categorie?: string | null
          specs?: Json | null
          statut?: Database["public"]["Enums"]["catalogue_statut"] | null
          unite?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_materiel_catalogue_fournisseur"
            columns: ["fournisseur_id"]
            isOneToOne: false
            referencedRelation: "fournisseurs"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          actif: boolean | null
          created_at: string | null
          email: string
          id: string
          nom: string | null
        }
        Insert: {
          actif?: boolean | null
          created_at?: string | null
          email: string
          id: string
          nom?: string | null
        }
        Update: {
          actif?: boolean | null
          created_at?: string | null
          email?: string
          id?: string
          nom?: string | null
        }
        Relationships: []
      }
      soumissions: {
        Row: {
          chantier_id: string
          date: string | null
          id: string
          remise_pct: number | null
          statut: string | null
          total_ht: number | null
          total_ttc: number | null
          tva_pct: number | null
        }
        Insert: {
          chantier_id: string
          date?: string | null
          id?: string
          remise_pct?: number | null
          statut?: string | null
          total_ht?: number | null
          total_ttc?: number | null
          tva_pct?: number | null
        }
        Update: {
          chantier_id?: string
          date?: string | null
          id?: string
          remise_pct?: number | null
          statut?: string | null
          total_ht?: number | null
          total_ttc?: number | null
          tva_pct?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_soumissions_chantier"
            columns: ["chantier_id"]
            isOneToOne: false
            referencedRelation: "chantiers"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_user_roles_profiles"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_admin: { Args: { _user_id: string }; Returns: boolean }
    }
    Enums: {
      app_role: "admin" | "membre"
      catalogue_statut: "brouillon" | "verifie"
      chantier_statut: "brouillon" | "en_cours" | "soumis" | "gagne" | "perdu"
      ligne_statut: "non_rempli" | "suggere" | "verifie"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "membre"],
      catalogue_statut: ["brouillon", "verifie"],
      chantier_statut: ["brouillon", "en_cours", "soumis", "gagne", "perdu"],
      ligne_statut: ["non_rempli", "suggere", "verifie"],
    },
  },
} as const