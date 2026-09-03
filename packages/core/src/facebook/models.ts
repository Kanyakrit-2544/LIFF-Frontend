export const FACEBOOK_POST_SCHEMA_VERSION = 1;

export interface FacebookPostEngagement {
  reactions: number;
  comments: number;
  shares: number;
  reach: number;
}

export interface FacebookPostDoc {
  _id: string;
  postId: string;
  message: string | null;
  hashtags: string[];
  courseCode: string | null;
  createdTime: Date;
  permalink: string | null;
  engagement: FacebookPostEngagement;
  adIds: string[];
  unmapped: boolean;
  fetchedAt: Date;
  updatedAt: Date;
  schemaVersion: number;
  seedTag?: string;
  synthetic?: boolean;
}

export interface GraphFacebookPost {
  id?: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  shares?: { count?: number };
}

export interface GraphPostInsights {
  data?: Array<{
    name?: string;
    values?: Array<{ value?: number }>;
  }>;
}
