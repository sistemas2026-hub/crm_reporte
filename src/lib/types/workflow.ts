export type ProcessStatus = 'PE' | 'SS' | 'ST' | 'ES'; // Pending, Success, Timeout, Escalated
export type ParticipantType = 'U' | 'SU' | 'SO' | 'DA'; // User, Supervisor, Service Owner, Domain Admin
export type WorkItemStatus = 'Pending' | 'Completed' | 'Expired';

export interface WorkflowProcess {
    id: string;
    process_type: string;
    reference_id?: string;
    title: string;
    priority: number;
    status: ProcessStatus;
    created_at: string;
    updated_at: string;
    metadata: Record<string, any>;
    escalation_level?: number;
}

export interface WorkflowActivity {
    id: string;
    process_id: string;
    name: string;
    status: 'Active' | 'Completed';
    started_at: string;
    completed_at?: string;
}

export interface WorkflowWorkItem {
    id: string;
    activity_id: string;
    participant_id: string;
    participant_type: ParticipantType;
    status: WorkItemStatus;
    deadline?: string;
    created_at: string;
    completed_at?: string;
}

export interface WorkflowLog {
    id: string;
    process_id: string;
    event_type: 'Creation' | 'Approval' | 'Timeout' | 'Escalation' | 'Rejection';
    description: string;
    actor_id?: string;
    created_at: string;
}

export interface PlatformUser {
    id: string;
    full_name: string | null;
    display_name: string;
    email: string | null;
    role: string | null;
    wisphub_id: string | null;
    operational_level: number | null;
    is_field_tech: boolean;
    is_profile: boolean;
    strategic_location: 'campo' | 'oficina' | null;
}
