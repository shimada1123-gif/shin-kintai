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
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      access_logs: {
        Row: {
          action: string
          created_at: string
          id: string
          target: string | null
          tenant_id: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          target?: string | null
          tenant_id?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          target?: string | null
          tenant_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "access_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      announcement_kinds: {
        Row: {
          announcement_id: string
          employment_kind_id: string
          id: string
        }
        Insert: {
          announcement_id: string
          employment_kind_id: string
          id?: string
        }
        Update: {
          announcement_id?: string
          employment_kind_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcement_kinds_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "announcement_kinds_employment_kind_id_fkey"
            columns: ["employment_kind_id"]
            isOneToOne: false
            referencedRelation: "employment_kinds"
            referencedColumns: ["id"]
          },
        ]
      }
      announcement_reads: {
        Row: {
          announcement_id: string
          id: string
          read_at: string
          user_id: string
        }
        Insert: {
          announcement_id: string
          id?: string
          read_at?: string
          user_id: string
        }
        Update: {
          announcement_id?: string
          id?: string
          read_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcement_reads_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
        ]
      }
      announcement_stores: {
        Row: {
          announcement_id: string
          id: string
          store_id: string
        }
        Insert: {
          announcement_id: string
          id?: string
          store_id: string
        }
        Update: {
          announcement_id?: string
          id?: string
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcement_stores_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "announcement_stores_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      announcements: {
        Row: {
          author: string | null
          body: string
          created_at: string
          deleted_at: string | null
          deleted_by: string | null
          id: string
          importance: string
          scope_type: string
          tenant_id: string
          title: string
          updated_at: string
        }
        Insert: {
          author?: string | null
          body: string
          created_at?: string
          deleted_at?: string | null
          deleted_by?: string | null
          id?: string
          importance?: string
          scope_type?: string
          tenant_id: string
          title: string
          updated_at?: string
        }
        Update: {
          author?: string | null
          body?: string
          created_at?: string
          deleted_at?: string | null
          deleted_by?: string | null
          id?: string
          importance?: string
          scope_type?: string
          tenant_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      areas: {
        Row: {
          created_at: string
          id: string
          name: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "areas_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance: {
        Row: {
          clock_in_at: string
          clock_out_at: string | null
          created_at: string
          gps_lat: number | null
          gps_lng: number | null
          gps_status: string
          id: string
          is_demo: boolean
          source: string
          staff_id: string
          store_id: string
          tenant_id: string
        }
        Insert: {
          clock_in_at?: string
          clock_out_at?: string | null
          created_at?: string
          gps_lat?: number | null
          gps_lng?: number | null
          gps_status?: string
          id?: string
          is_demo?: boolean
          source?: string
          staff_id: string
          store_id: string
          tenant_id: string
        }
        Update: {
          clock_in_at?: string
          clock_out_at?: string | null
          created_at?: string
          gps_lat?: number | null
          gps_lng?: number | null
          gps_status?: string
          id?: string
          is_demo?: boolean
          source?: string
          staff_id?: string
          store_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_breaks: {
        Row: {
          attendance_id: string
          break_end_at: string | null
          break_start_at: string
          id: string
        }
        Insert: {
          attendance_id: string
          break_end_at?: string | null
          break_start_at?: string
          id?: string
        }
        Update: {
          attendance_id?: string
          break_end_at?: string | null
          break_start_at?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_breaks_attendance_id_fkey"
            columns: ["attendance_id"]
            isOneToOne: false
            referencedRelation: "attendance"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_corrections: {
        Row: {
          approved_by: string | null
          attendance_id: string
          created_at: string
          id: string
          new_value: string | null
          old_value: string | null
          reason: string | null
          requested_by: string | null
          status: string
          target_field: string
          tenant_id: string
        }
        Insert: {
          approved_by?: string | null
          attendance_id: string
          created_at?: string
          id?: string
          new_value?: string | null
          old_value?: string | null
          reason?: string | null
          requested_by?: string | null
          status?: string
          target_field: string
          tenant_id: string
        }
        Update: {
          approved_by?: string | null
          attendance_id?: string
          created_at?: string
          id?: string
          new_value?: string | null
          old_value?: string | null
          reason?: string | null
          requested_by?: string | null
          status?: string
          target_field?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_corrections_attendance_id_fkey"
            columns: ["attendance_id"]
            isOneToOne: false
            referencedRelation: "attendance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_corrections_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_deliveries: {
        Row: {
          announcement_id: string
          created_at: string
          email: string
          error: string | null
          id: string
          sent_at: string | null
          status: string
          user_id: string | null
        }
        Insert: {
          announcement_id: string
          created_at?: string
          email: string
          error?: string | null
          id?: string
          sent_at?: string | null
          status?: string
          user_id?: string | null
        }
        Update: {
          announcement_id?: string
          created_at?: string
          email?: string
          error?: string | null
          id?: string
          sent_at?: string | null
          status?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_deliveries_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
        ]
      }
      employment_kinds: {
        Row: {
          applies_premium: boolean
          created_at: string
          id: string
          is_hourly: boolean
          is_regular: boolean
          label: string
          requires_clock: boolean
          tenant_id: string
        }
        Insert: {
          applies_premium?: boolean
          created_at?: string
          id?: string
          is_hourly?: boolean
          is_regular?: boolean
          label: string
          requires_clock?: boolean
          tenant_id: string
        }
        Update: {
          applies_premium?: boolean
          created_at?: string
          id?: string
          is_hourly?: boolean
          is_regular?: boolean
          label?: string
          requires_clock?: boolean
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "employment_kinds_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      holidays: {
        Row: {
          holiday_date: string
          name: string
        }
        Insert: {
          holiday_date: string
          name: string
        }
        Update: {
          holiday_date?: string
          name?: string
        }
        Relationships: []
      }
      meal_records: {
        Row: {
          created_at: string
          entered_by: string
          entered_by_user: string | null
          id: string
          meal_type: string
          price_snapshot: number
          staff_id: string
          store_id: string
          tenant_id: string
          updated_at: string
          work_date: string
        }
        Insert: {
          created_at?: string
          entered_by: string
          entered_by_user?: string | null
          id?: string
          meal_type: string
          price_snapshot?: number
          staff_id: string
          store_id: string
          tenant_id: string
          updated_at?: string
          work_date: string
        }
        Update: {
          created_at?: string
          entered_by?: string
          entered_by_user?: string | null
          id?: string
          meal_type?: string
          price_snapshot?: number
          staff_id?: string
          store_id?: string
          tenant_id?: string
          updated_at?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "meal_records_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meal_records_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meal_records_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          created_at: string
          id: string
          role: string
          scope_area_id: string | null
          scope_store_id: string | null
          staff_id: string | null
          tenant_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: string
          scope_area_id?: string | null
          scope_store_id?: string | null
          staff_id?: string | null
          tenant_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: string
          scope_area_id?: string | null
          scope_store_id?: string | null
          staff_id?: string | null
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_scope_area_id_fkey"
            columns: ["scope_area_id"]
            isOneToOne: false
            referencedRelation: "areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memberships_scope_store_id_fkey"
            columns: ["scope_store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memberships_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memberships_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      positions: {
        Row: {
          color: string | null
          created_at: string
          id: string
          is_active: boolean
          name: string
          sort_order: number
          store_id: string | null
          tenant_id: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          sort_order?: number
          store_id?: string | null
          tenant_id: string
        }
        Update: {
          color?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          sort_order?: number
          store_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "positions_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "positions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      qr_tokens: {
        Row: {
          expires_at: string
          id: string
          issued_at: string
          kind: string | null
          store_id: string
          token: string
          used_at: string | null
          used_by: string | null
        }
        Insert: {
          expires_at: string
          id?: string
          issued_at?: string
          kind?: string | null
          store_id: string
          token: string
          used_at?: string | null
          used_by?: string | null
        }
        Update: {
          expires_at?: string
          id?: string
          issued_at?: string
          kind?: string | null
          store_id?: string
          token?: string
          used_at?: string | null
          used_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "qr_tokens_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qr_tokens_used_by_fkey"
            columns: ["used_by"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          allowed: boolean
          id: string
          permission_key: string
          role: string
          tenant_id: string
        }
        Insert: {
          allowed?: boolean
          id?: string
          permission_key: string
          role: string
          tenant_id: string
        }
        Update: {
          allowed?: boolean
          id?: string
          permission_key?: string
          role?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_assignments: {
        Row: {
          created_at: string
          end_min: number
          id: string
          note: string | null
          notified_at: string | null
          position_id: string | null
          staff_id: string
          start_min: number
          status: string
          store_id: string
          tenant_id: string
          updated_at: string
          weight_half: boolean
          work_date: string
        }
        Insert: {
          created_at?: string
          end_min: number
          id?: string
          note?: string | null
          notified_at?: string | null
          position_id?: string | null
          staff_id: string
          start_min: number
          status?: string
          store_id: string
          tenant_id: string
          updated_at?: string
          weight_half?: boolean
          work_date: string
        }
        Update: {
          created_at?: string
          end_min?: number
          id?: string
          note?: string | null
          notified_at?: string | null
          position_id?: string | null
          staff_id?: string
          start_min?: number
          status?: string
          store_id?: string
          tenant_id?: string
          updated_at?: string
          weight_half?: boolean
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_assignments_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_assignments_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_assignments_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_assignments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_availability: {
        Row: {
          created_at: string
          end_min: number | null
          id: string
          kind: string
          note: string | null
          staff_id: string
          start_min: number | null
          store_id: string
          tenant_id: string
          updated_at: string
          work_date: string
        }
        Insert: {
          created_at?: string
          end_min?: number | null
          id?: string
          kind?: string
          note?: string | null
          staff_id: string
          start_min?: number | null
          store_id: string
          tenant_id: string
          updated_at?: string
          work_date: string
        }
        Update: {
          created_at?: string
          end_min?: number | null
          id?: string
          kind?: string
          note?: string | null
          staff_id?: string
          start_min?: number | null
          store_id?: string
          tenant_id?: string
          updated_at?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_availability_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_availability_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_availability_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_offer_recipients: {
        Row: {
          comment: string | null
          created_at: string
          email: string | null
          id: string
          mgr_seen_at: string | null
          offer_id: string
          responded_at: string | null
          response: string
          sent_at: string | null
          staff_id: string
          token_hash: string
        }
        Insert: {
          comment?: string | null
          created_at?: string
          email?: string | null
          id?: string
          mgr_seen_at?: string | null
          offer_id: string
          responded_at?: string | null
          response?: string
          sent_at?: string | null
          staff_id: string
          token_hash: string
        }
        Update: {
          comment?: string | null
          created_at?: string
          email?: string | null
          id?: string
          mgr_seen_at?: string | null
          offer_id?: string
          responded_at?: string | null
          response?: string
          sent_at?: string | null
          staff_id?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_offer_recipients_offer_id_fkey"
            columns: ["offer_id"]
            isOneToOne: false
            referencedRelation: "shift_offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_offer_recipients_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_offers: {
        Row: {
          created_at: string
          created_by: string | null
          deadline_at: string
          end_min: number
          filled_at: string | null
          id: string
          note: string | null
          position_id: string | null
          start_min: number
          status: string
          store_id: string
          tenant_id: string
          weight_half: boolean
          winner_staff_id: string | null
          work_date: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          deadline_at: string
          end_min: number
          filled_at?: string | null
          id?: string
          note?: string | null
          position_id?: string | null
          start_min: number
          status?: string
          store_id: string
          tenant_id: string
          weight_half?: boolean
          winner_staff_id?: string | null
          work_date: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          deadline_at?: string
          end_min?: number
          filled_at?: string | null
          id?: string
          note?: string | null
          position_id?: string | null
          start_min?: number
          status?: string
          store_id?: string
          tenant_id?: string
          weight_half?: boolean
          winner_staff_id?: string | null
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_offers_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_offers_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_offers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_offers_winner_staff_id_fkey"
            columns: ["winner_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_requirement_overrides: {
        Row: {
          created_at: string
          id: string
          memo: string | null
          min_by_kind: Json
          need_by_position: Json
          need_count: number
          store_id: string
          tenant_id: string
          time_band_id: string | null
          updated_at: string
          work_date: string
        }
        Insert: {
          created_at?: string
          id?: string
          memo?: string | null
          min_by_kind?: Json
          need_by_position?: Json
          need_count?: number
          store_id: string
          tenant_id: string
          time_band_id?: string | null
          updated_at?: string
          work_date: string
        }
        Update: {
          created_at?: string
          id?: string
          memo?: string | null
          min_by_kind?: Json
          need_by_position?: Json
          need_count?: number
          store_id?: string
          tenant_id?: string
          time_band_id?: string | null
          updated_at?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_requirement_overrides_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_requirement_overrides_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_requirement_overrides_time_band_id_fkey"
            columns: ["time_band_id"]
            isOneToOne: false
            referencedRelation: "shift_time_bands"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_requirements: {
        Row: {
          created_at: string
          day_type: string
          id: string
          memo: string | null
          min_by_kind: Json
          need_by_position: Json
          need_count: number
          store_id: string
          tenant_id: string
          time_band_id: string | null
        }
        Insert: {
          created_at?: string
          day_type: string
          id?: string
          memo?: string | null
          min_by_kind?: Json
          need_by_position?: Json
          need_count?: number
          store_id: string
          tenant_id: string
          time_band_id?: string | null
        }
        Update: {
          created_at?: string
          day_type?: string
          id?: string
          memo?: string | null
          min_by_kind?: Json
          need_by_position?: Json
          need_count?: number
          store_id?: string
          tenant_id?: string
          time_band_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shift_requirements_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_requirements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_requirements_time_band_id_fkey"
            columns: ["time_band_id"]
            isOneToOne: false
            referencedRelation: "shift_time_bands"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_time_bands: {
        Row: {
          created_at: string
          end_min: number
          id: string
          is_active: boolean
          name: string
          sort_order: number
          start_min: number
          store_id: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          end_min: number
          id?: string
          is_active?: boolean
          name: string
          sort_order?: number
          start_min: number
          store_id: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          end_min?: number
          id?: string
          is_active?: boolean
          name?: string
          sort_order?: number
          start_min?: number
          store_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_time_bands_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_time_bands_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      staff: {
        Row: {
          created_at: string
          email: string | null
          full_name: string
          id: string
          is_active: boolean
          phone: string | null
          retired_at: string | null
          status: string
          tenant_id: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          email?: string | null
          full_name: string
          id?: string
          is_active?: boolean
          phone?: string | null
          retired_at?: string | null
          status?: string
          tenant_id: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
          is_active?: boolean
          phone?: string | null
          retired_at?: string | null
          status?: string
          tenant_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_assignments: {
        Row: {
          commute_amount: number
          commute_type: string
          created_at: string
          employment_kind_id: string | null
          hourly_wage: number | null
          id: string
          is_active: boolean
          is_newbie: boolean
          is_trainer: boolean
          monthly_fixed: number | null
          position_default_id: string | null
          staff_id: string
          store_id: string
          tenant_id: string
          wage_type: string
        }
        Insert: {
          commute_amount?: number
          commute_type?: string
          created_at?: string
          employment_kind_id?: string | null
          hourly_wage?: number | null
          id?: string
          is_active?: boolean
          is_newbie?: boolean
          is_trainer?: boolean
          monthly_fixed?: number | null
          position_default_id?: string | null
          staff_id: string
          store_id: string
          tenant_id: string
          wage_type?: string
        }
        Update: {
          commute_amount?: number
          commute_type?: string
          created_at?: string
          employment_kind_id?: string | null
          hourly_wage?: number | null
          id?: string
          is_active?: boolean
          is_newbie?: boolean
          is_trainer?: boolean
          monthly_fixed?: number | null
          position_default_id?: string | null
          staff_id?: string
          store_id?: string
          tenant_id?: string
          wage_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_assignments_employment_kind_id_fkey"
            columns: ["employment_kind_id"]
            isOneToOne: false
            referencedRelation: "employment_kinds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_assignments_position_default_id_fkey"
            columns: ["position_default_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_assignments_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_assignments_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_assignments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_day_off: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          kind: string
          note: string | null
          staff_id: string
          store_id: string
          tenant_id: string
          work_date: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          note?: string | null
          staff_id: string
          store_id: string
          tenant_id: string
          work_date: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          note?: string | null
          staff_id?: string
          store_id?: string
          tenant_id?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_day_off_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_day_off_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_day_off_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_skills: {
        Row: {
          can: boolean
          created_at: string
          id: string
          level: number | null
          position_id: string
          staff_id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          can?: boolean
          created_at?: string
          id?: string
          level?: number | null
          position_id: string
          staff_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          can?: boolean
          created_at?: string
          id?: string
          level?: number | null
          position_id?: string
          staff_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_skills_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_skills_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_skills_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_tags: {
        Row: {
          created_at: string
          id: string
          staff_id: string
          tag: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          staff_id: string
          tag: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          staff_id?: string
          tag?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_tags_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_tags_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      stores: {
        Row: {
          area_id: string | null
          created_at: string
          geofence_radius_m: number
          gps_policy: string
          id: string
          lat: number | null
          lng: number | null
          name: string
          settings: Json
          tenant_id: string
          timezone: string
        }
        Insert: {
          area_id?: string | null
          created_at?: string
          geofence_radius_m?: number
          gps_policy?: string
          id?: string
          lat?: number | null
          lng?: number | null
          name: string
          settings?: Json
          tenant_id: string
          timezone?: string
        }
        Update: {
          area_id?: string | null
          created_at?: string
          geofence_radius_m?: number
          gps_policy?: string
          id?: string
          lat?: number | null
          lng?: number | null
          name?: string
          settings?: Json
          tenant_id?: string
          timezone?: string
        }
        Relationships: [
          {
            foreignKeyName: "stores_area_id_fkey"
            columns: ["area_id"]
            isOneToOne: false
            referencedRelation: "areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stores_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          created_at: string
          id: string
          name: string
          settings: Json
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          settings?: Json
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          settings?: Json
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      app_announcement_delete: { Args: { aid: string }; Returns: boolean }
      app_announcement_manage: { Args: { aid: string }; Returns: boolean }
      app_announcement_visible: { Args: { aid: string }; Returns: boolean }
      app_can_store: { Args: { sid: string }; Returns: boolean }
      app_delete_staff: {
        Args: { p_staff_id: string; p_tenant_id: string }
        Returns: undefined
      }
      app_has_perm: { Args: { perm: string; tid: string }; Returns: boolean }
      app_is_member: { Args: { tid: string }; Returns: boolean }
      app_labor_cost: {
        Args: { p_from: string; p_store_id: string; p_to: string }
        Returns: {
          cost_yen: number
          excluded_count: number
          staff_count: number
          status: string
          total_min: number
          work_date: string
        }[]
      }
      app_meal_summary: {
        Args: { p_from: string; p_store_id: string; p_to: string }
        Returns: {
          meal_count: number
          staff_id: string
          total_yen: number
        }[]
      }
      app_my_offers: {
        Args: never
        Returns: {
          deadline_at: string
          end_min: number
          is_my_win: boolean
          my_comment: string
          my_response: string
          offer_id: string
          offer_status: string
          position_name: string
          responded_at: string
          start_min: number
          work_date: string
        }[]
      }
      app_offer_accept: {
        Args: { p_comment: string; p_token: string }
        Returns: Json
      }
      app_offer_confirm: { Args: { p_recipient_id: string }; Returns: Json }
      app_offer_decline: { Args: { p_token: string }; Returns: Json }
      app_offer_expire_due: { Args: never; Returns: number }
      app_reinstate_staff: {
        Args: { p_staff_id: string; p_tenant_id: string }
        Returns: undefined
      }
      app_reorder_positions: {
        Args: { p_ids: string[]; p_tenant_id: string }
        Returns: undefined
      }
      app_retire_staff: {
        Args: { p_retired_at: string; p_staff_id: string; p_tenant_id: string }
        Returns: undefined
      }
      app_role: { Args: { tid: string }; Returns: string }
      app_set_position_active: {
        Args: {
          p_active: boolean
          p_id: string
          p_store_id: string
          p_tenant_id: string
        }
        Returns: undefined
      }
      app_set_skill: {
        Args: {
          p_can: boolean
          p_level: number
          p_position_id: string
          p_staff_id: string
          p_tenant_id: string
        }
        Returns: string
      }
      app_set_staff_active: {
        Args: { p_active: boolean; p_staff_id: string; p_tenant_id: string }
        Returns: undefined
      }
      app_staff_id: { Args: { tid: string }; Returns: string }
      app_staff_see_corr: { Args: { tid: string }; Returns: boolean }
      app_store_roster: {
        Args: { p_store_id: string }
        Returns: {
          employment_kind_id: string
          full_name: string
          is_newbie: boolean
          is_regular: boolean
          is_trainer: boolean
          kind_label: string
          position_default_id: string
          requires_clock: boolean
          staff_id: string
        }[]
      }
      app_store_skills: {
        Args: { p_store_id: string }
        Returns: {
          can: boolean
          level: number
          position_id: string
          staff_id: string
        }[]
      }
      app_tenant_test_mode: { Args: { tid: string }; Returns: boolean }
      app_upsert_meal: {
        Args: {
          p_meal_type: string
          p_present: boolean
          p_staff_id: string
          p_store_id: string
          p_work_date: string
        }
        Returns: string
      }
      app_upsert_position: {
        Args: {
          p_color: string
          p_id: string
          p_name: string
          p_store_id: string
          p_tenant_id: string
        }
        Returns: string
      }
      seed_role_permissions: { Args: { tid: string }; Returns: undefined }
    }
    Enums: {
      [_ in never]: never
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
