import { pgTable, text, serial, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const videos = pgTable("videos", {
  id: serial("id").primaryKey(),
  videoId: text("video_id").notNull().unique(),
  title: text("title").notNull(),
  channelTitle: text("channel_title").notNull(),
  channelId: text("channel_id").notNull(),
  publishedAt: timestamp("published_at").notNull(),
  duration: text("duration"),
  viewCount: integer("view_count").notNull(),
  likeCount: integer("like_count"),
  commentCount: integer("comment_count"),
  subscriberCount: integer("subscriber_count"),
  thumbnailUrl: text("thumbnail_url"),
  description: text("description"),
  tags: text("tags").array(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const aiAnalyses = pgTable("ai_analyses", {
  id: serial("id").primaryKey(),
  videoId: text("video_id").notNull(),
  trends: jsonb("trends"),
  targets: jsonb("targets"),
  hooks: jsonb("hooks"),
  suggestedTitles: jsonb("suggested_titles"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const scripts = pgTable("scripts", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  format: text("format").notNull(), // shorts, short, long
  tone: text("tone").notNull(), // friendly, professional, casual, enthusiastic
  keywords: text("keywords"),
  audience: text("audience"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertVideoSchema = createInsertSchema(videos).omit({
  id: true,
  createdAt: true,
});

export const insertAIAnalysisSchema = createInsertSchema(aiAnalyses).omit({
  id: true,
  createdAt: true,
});

export const insertScriptSchema = createInsertSchema(scripts).omit({
  id: true,
  createdAt: true,
});

export type Video = typeof videos.$inferSelect;
export type InsertVideo = z.infer<typeof insertVideoSchema>;
export type AIAnalysis = typeof aiAnalyses.$inferSelect;
export type InsertAIAnalysis = z.infer<typeof insertAIAnalysisSchema>;
export type Script = typeof scripts.$inferSelect;
export type InsertScript = z.infer<typeof insertScriptSchema>;

// Search and filter schemas
export const searchParamsSchema = z.object({
  keyword: z.string().min(1),
  sortOrder: z.enum(["viewCount", "date", "relevance"]).default("viewCount"),
  publishTime: z.enum(["week", "month", "year"]).default("month"),
  videoDuration: z.enum(["any", "short", "medium", "long"]).default("any"),
  ageGroup: z.string().optional(), // Age group for filtering: "10대", "20대", etc.
  excludeKeywords: z.string().optional(), // Comma-separated keywords to exclude
});

export type SearchParams = z.infer<typeof searchParamsSchema>;
