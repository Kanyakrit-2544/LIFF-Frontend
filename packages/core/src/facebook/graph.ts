import { env } from "../env";
import type { GraphFacebookPost, GraphPostInsights } from "./models";

export interface FacebookGraphPort {
  listPosts(since: Date): Promise<GraphFacebookPost[]>;
  getPost(postId: string): Promise<GraphFacebookPost | null>;
  getPostInsights(postId: string): Promise<GraphPostInsights | null>;
  resolveAdPostId(adId: string): Promise<string | null>;
}

interface GraphPage<T> {
  data?: T[];
  paging?: { cursors?: { after?: string } };
}

export class MetaFacebookGraphClient implements FacebookGraphPort {
  constructor(
    private readonly token: string,
    private readonly pageId: string,
    private readonly version: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  private async request<T>(path: string, params: Record<string, string>, soft = false): Promise<T | null> {
    const url = new URL(`https://graph.facebook.com/${this.version}/${path.replace(/^\//, "")}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await this.fetcher(url, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      if (soft) return null;
      const payload = (await response.text()).slice(0, 300);
      throw new Error(`Facebook Graph API ${response.status}: ${payload}`);
    }
    return await response.json() as T;
  }

  async listPosts(since: Date): Promise<GraphFacebookPost[]> {
    const posts: GraphFacebookPost[] = [];
    let after: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.request<GraphPage<GraphFacebookPost>>(`${encodeURIComponent(this.pageId)}/posts`, {
        fields: "id,message,created_time,permalink_url,reactions.limit(0).summary(true),comments.limit(0).summary(true),shares",
        since: String(Math.floor(since.getTime() / 1000)),
        limit: "100",
        ...(after ? { after } : {}),
      });
      posts.push(...(result?.data ?? []));
      const next = result?.paging?.cursors?.after;
      if (!next || next === after || (result?.data?.length ?? 0) === 0) break;
      after = next;
    }
    return posts;
  }

  async getPostInsights(postId: string): Promise<GraphPostInsights | null> {
    return this.request<GraphPostInsights>(`${encodeURIComponent(postId)}/insights`, {
      metric: "post_impressions_unique",
      period: "lifetime",
    }, true);
  }

  async getPost(postId: string): Promise<GraphFacebookPost | null> {
    return this.request<GraphFacebookPost>(encodeURIComponent(postId), {
      fields: "id,message,created_time,permalink_url,reactions.limit(0).summary(true),comments.limit(0).summary(true),shares",
    }, true);
  }

  async resolveAdPostId(adId: string): Promise<string | null> {
    const result = await this.request<{
      creative?: { effective_object_story_id?: string; object_story_id?: string };
    }>(encodeURIComponent(adId), {
      fields: "creative{id,effective_object_story_id,object_story_id}",
    }, true);
    return result?.creative?.effective_object_story_id ?? result?.creative?.object_story_id ?? null;
  }
}

export function createFacebookGraphClient(): FacebookGraphPort | null {
  const config = env("facebook");
  if (!config.FACEBOOK_PAGE_TOKEN || !config.FACEBOOK_PAGE_ID) return null;
  return new MetaFacebookGraphClient(
    config.FACEBOOK_PAGE_TOKEN,
    config.FACEBOOK_PAGE_ID,
    config.FACEBOOK_GRAPH_VERSION
  );
}
