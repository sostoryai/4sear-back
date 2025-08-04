import { videos, aiAnalyses, scripts, type Video, type InsertVideo, type AIAnalysis, type InsertAIAnalysis, type Script, type InsertScript } from "@shared/schema";

export interface IStorage {
  // Video operations
  getVideo(videoId: string): Promise<Video | undefined>;
  createVideo(video: InsertVideo): Promise<Video>;
  getVideosByKeyword(keyword: string): Promise<Video[]>;
  
  // AI Analysis operations
  getAIAnalysis(videoId: string): Promise<AIAnalysis | undefined>;
  createAIAnalysis(analysis: InsertAIAnalysis): Promise<AIAnalysis>;
  
  // Script operations
  getScript(id: number): Promise<Script | undefined>;
  createScript(script: InsertScript): Promise<Script>;
  getUserScripts(): Promise<Script[]>;
}

export class MemStorage implements IStorage {
  private videos: Map<string, Video>;
  private aiAnalyses: Map<string, AIAnalysis>;
  private scripts: Map<number, Script>;
  private currentVideoId: number;
  private currentAnalysisId: number;
  private currentScriptId: number;

  constructor() {
    this.videos = new Map();
    this.aiAnalyses = new Map();
    this.scripts = new Map();
    this.currentVideoId = 1;
    this.currentAnalysisId = 1;
    this.currentScriptId = 1;
  }

  async getVideo(videoId: string): Promise<Video | undefined> {
    return this.videos.get(videoId);
  }

  async createVideo(insertVideo: InsertVideo): Promise<Video> {
    const id = this.currentVideoId++;
    const video: Video = { 
      ...insertVideo, 
      id,
      createdAt: new Date()
    };
    this.videos.set(insertVideo.videoId, video);
    return video;
  }

  async getVideosByKeyword(keyword: string): Promise<Video[]> {
    return Array.from(this.videos.values()).filter(
      (video) => 
        video.title.toLowerCase().includes(keyword.toLowerCase()) ||
        video.description?.toLowerCase().includes(keyword.toLowerCase())
    );
  }

  async getAIAnalysis(videoId: string): Promise<AIAnalysis | undefined> {
    return this.aiAnalyses.get(videoId);
  }

  async createAIAnalysis(insertAnalysis: InsertAIAnalysis): Promise<AIAnalysis> {
    const id = this.currentAnalysisId++;
    const analysis: AIAnalysis = {
      ...insertAnalysis,
      id,
      createdAt: new Date()
    };
    this.aiAnalyses.set(insertAnalysis.videoId, analysis);
    return analysis;
  }

  async getScript(id: number): Promise<Script | undefined> {
    return this.scripts.get(id);
  }

  async createScript(insertScript: InsertScript): Promise<Script> {
    const id = this.currentScriptId++;
    const script: Script = {
      ...insertScript,
      id,
      createdAt: new Date()
    };
    this.scripts.set(id, script);
    return script;
  }

  async getUserScripts(): Promise<Script[]> {
    return Array.from(this.scripts.values());
  }
}

export const storage = new MemStorage();
