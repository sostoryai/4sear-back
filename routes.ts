import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { spawn } from "child_process";
import { storage } from "./storage";
import { searchParamsSchema, insertAIAnalysisSchema, insertScriptSchema } from "@shared/schema";
import { z } from "zod";
import OpenAI from "openai";
import { apiKeyManager } from './api-key-manager';
import { YoutubeTranscript } from "youtube-transcript";
import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import axios from "axios";

// YouTube API types
interface YouTubeVideo {
  id: { videoId: string };
  snippet: {
    title: string;
    channelTitle: string;
    channelId: string;
    publishedAt: string;
    thumbnails: { medium: { url: string } };
    description: string;
    tags?: string[];
  };
  statistics?: {
    viewCount: string;
    likeCount: string;
    commentCount: string;
  };
  contentDetails?: {
    duration: string;
  };
}

interface YouTubeChannel {
  statistics: {
    subscriberCount: string;
  };
  snippet: {
    publishedAt: string;
  };
}

const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || ""
});

// Get current YouTube API key from manager
function getCurrentYouTubeApiKey(): string | null {
  return apiKeyManager.getActiveKey();
}

async function makeYouTubeApiRequest(url: string, params: URLSearchParams, retryCount = 0): Promise<any> {
  const currentKey = getCurrentYouTubeApiKey();
  if (!currentKey) {
    throw new Error("사용 가능한 YouTube API 키가 없습니다.");
  }

  params.set('key', currentKey);
  const response = await fetch(`${url}?${params}`);
  const data = await response.json();

  if (data.error) {
    console.log(`API Error Details:`, JSON.stringify(data.error, null, 2));
    
    if ((data.error.reason === 'quotaExceeded' || data.error.code === 403) && retryCount < 2) {
      console.log(`API key quota exceeded, switching to next available key...`);
      apiKeyManager.markKeyAsExceeded(currentKey);
      const switched = apiKeyManager.switchToNextAvailableKey();
      
      if (switched) {
        console.log(`Switched to new API key, retrying request...`);
        return makeYouTubeApiRequest(url, params, retryCount + 1);
      } else {
        throw new Error("모든 YouTube API 키의 할당량이 초과되었습니다. 새로운 API 키를 추가하거나 내일 다시 시도해주세요.");
      }
    }
    throw new Error(`YouTube API error: ${data.error.message || data.error.code}`);
  }

  return data;
}

// Great filter algorithm
const isGreatVideo = (views: number, subscribers: number): boolean => {
  const ratio = views / (subscribers + 1);
  return views >= 10000 && ratio >= 30;
};

const getPerformanceLevel = (views: number, subscribers: number): string => {
  const ratio = views / (subscribers + 1);
  if (views >= 10000 && ratio >= 30) return "great";
  if (ratio >= 10) return "good";
  return "normal";
};

// YouTube API helper
async function searchYouTubeVideos(params: {
  keyword: string;
  sortOrder: string;
  publishTime: string;
  videoDuration: string;
  excludeKeywords?: string;
}): Promise<any[]> {
  const baseUrl = "https://www.googleapis.com/youtube/v3/search";
  const searchParams = new URLSearchParams({
    part: "snippet",
    q: params.keyword,
    type: "video",
    order: params.sortOrder === "date" ? "date" : params.sortOrder === "relevance" ? "relevance" : "viewCount",
    publishedAfter: params.publishTime === "week" 
      ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      : params.publishTime === "month"
      ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    videoDuration: params.videoDuration === "short" ? "short" : params.videoDuration === "medium" ? "medium" : params.videoDuration === "long" ? "long" : "any",
    maxResults: "50"
  });

  const data = await makeYouTubeApiRequest(baseUrl, searchParams);
  const videoIds = data.items.map((item: YouTubeVideo) => item.id.videoId).join(",");

  // Get video statistics and details
  const statsUrl = "https://www.googleapis.com/youtube/v3/videos";
  const statsParams = new URLSearchParams({
    part: "statistics,contentDetails",
    id: videoIds
  });

  const statsData = await makeYouTubeApiRequest(statsUrl, statsParams);

  // Get channel statistics for subscriber counts
  const channelIds = data.items.map((item: YouTubeVideo) => item.snippet.channelId).join(",");
  const channelUrl = "https://www.googleapis.com/youtube/v3/channels";
  const channelParams = new URLSearchParams({
    part: "statistics,snippet",
    id: channelIds
  });

  const channelData = await makeYouTubeApiRequest(channelUrl, channelParams);

  // Parse exclude keywords
  const excludeKeywordsList = params.excludeKeywords 
    ? params.excludeKeywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k.length > 0)
    : [];
  
  console.log('Exclude keywords:', excludeKeywordsList);

  // Combine data and filter
  const videos = data.items.map((item: YouTubeVideo, index: number) => {
    const stats = statsData.items[index]?.statistics || {};
    const contentDetails = statsData.items[index]?.contentDetails || {};
    const channel = channelData.items.find((ch: any) => ch.id === item.snippet.channelId);
    const channelStats = channel?.statistics || {};
    const channelSnippet = channel?.snippet || {};

    const viewCount = parseInt(stats.viewCount || "0");
    const subscriberCount = parseInt(channelStats.subscriberCount || "0");

    return {
      videoId: item.id.videoId,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      channelId: item.snippet.channelId,
      channelCreatedAt: channelSnippet.publishedAt ? new Date(channelSnippet.publishedAt) : null,
      publishedAt: new Date(item.snippet.publishedAt),
      duration: contentDetails.duration || "",
      viewCount,
      likeCount: parseInt(stats.likeCount || "0"),
      commentCount: parseInt(stats.commentCount || "0"),
      subscriberCount,
      thumbnailUrl: item.snippet.thumbnails.medium.url,
      description: item.snippet.description || "",
      tags: item.snippet.tags || [],
      performanceLevel: getPerformanceLevel(viewCount, subscriberCount),
      cii: viewCount / (subscriberCount + 1),
      engagementRate: viewCount > 0 ? ((parseInt(stats.likeCount || "0") + parseInt(stats.commentCount || "0")) / viewCount * 100) : 0
    };
  });

  // Filter out videos containing exclude keywords
  if (excludeKeywordsList.length > 0) {
    console.log(`Before filtering: ${videos.length} videos`);
    const filteredVideos = videos.filter(video => {
      const titleLower = video.title.toLowerCase();
      const descriptionLower = video.description.toLowerCase();
      const channelTitleLower = video.channelTitle.toLowerCase();
      
      // Check if any exclude keyword is found in title, description, or channel name
      const shouldExclude = excludeKeywordsList.some(excludeKeyword => 
        titleLower.includes(excludeKeyword) || 
        descriptionLower.includes(excludeKeyword) ||
        channelTitleLower.includes(excludeKeyword)
      );
      
      if (shouldExclude) {
        console.log(`Filtering out video: "${video.title}" (contains excluded keyword)`);
      }
      
      return !shouldExclude;
    });
    console.log(`After filtering: ${filteredVideos.length} videos`);
    return filteredVideos;
  }

  return videos;
}

// Advanced content analysis function
function performAdvancedContentAnalysis(videos: any[]): any[] {
  // Define content categories with patterns
  const contentCategories = {
    '요리/레시피': {
      keywords: ['요리', '레시피', '만들기', '음식', '맛있는', '간단한', '집밥', '홈쿡', '쿠킹'],
      patterns: ['분 만에', '초간단', '집에서', '홈메이드', '레시피']
    },
    '건강/다이어트': {
      keywords: ['건강', '다이어트', '운동', '살빼기', '헬스', '피트니스', '체중', '몸매'],
      patterns: ['일주일', '30일', '습관', '챌린지', '효과']
    },
    '일상/브이로그': {
      keywords: ['일상', '브이로그', 'vlog', '하루', '루틴', '데일리'],
      patterns: ['하루종일', '함께', '같이', '데이트', '여행']
    },
    '뷰티/패션': {
      keywords: ['메이크업', '화장', '스킨케어', '패션', '옷', '스타일링', '코디'],
      patterns: ['겟레디', '룩북', '하울', '리뷰', '추천']
    },
    '게임/엔터테인먼트': {
      keywords: ['게임', '플레이', '리뷰', '공략', '랭킹', '챌린지'],
      patterns: ['vs', '대결', '실험', '테스트', '도전']
    },
    '교육/정보': {
      keywords: ['배우기', '공부', '설명', '방법', '팁', '노하우', '알려드릴게요'],
      patterns: ['하는법', '방법', '꿀팁', '정리', '총정리']
    }
  };

  const videoAnalysis = videos.map(video => {
    const content = `${video.title} ${video.description} ${video.tags.join(' ')}`.toLowerCase();
    let bestCategory = '기타';
    let maxScore = 0;

    Object.entries(contentCategories).forEach(([category, data]) => {
      let score = 0;
      
      // Keyword matching
      data.keywords.forEach(keyword => {
        if (content.includes(keyword)) score += 2;
      });
      
      // Pattern matching
      data.patterns.forEach(pattern => {
        if (content.includes(pattern)) score += 3;
      });

      if (score > maxScore) {
        maxScore = score;
        bestCategory = category;
      }
    });

    return { ...video, category: bestCategory, score: maxScore };
  });

  // Group by categories and analyze success patterns
  const categoryGroups = new Map();
  videoAnalysis.forEach(video => {
    if (!categoryGroups.has(video.category)) {
      categoryGroups.set(video.category, []);
    }
    categoryGroups.get(video.category).push(video);
  });

  // Create detailed pattern analysis
  const patterns = Array.from(categoryGroups.entries())
    .filter(([category, videos]) => videos.length > 0)
    .map(([category, videos]) => {
      // Analyze success factors
      const avgViews = videos.reduce((sum, v) => sum + v.viewCount, 0) / videos.length;
      const topVideos = videos.sort((a, b) => b.viewCount - a.viewCount).slice(0, 3);
      
      // Extract common success patterns
      const titleWords = topVideos.flatMap(v => v.title.split(' '));
      const commonWords = {};
      titleWords.forEach(word => {
        const clean = word.replace(/[^\w가-힣]/g, '').toLowerCase();
        if (clean.length > 1) {
          commonWords[clean] = (commonWords[clean] || 0) + 1;
        }
      });
      
      const frequentWords = Object.entries(commonWords)
        .filter(([word, count]) => count >= 2)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .map(([word]) => word);

      // Analyze engagement patterns
      const avgEngagement = videos.reduce((sum, v) => {
        const engagement = (v.viewCount > 0) ? ((v.likeCount + v.commentCount) / v.viewCount * 100) : 0;
        return sum + engagement;
      }, 0) / videos.length;

      // Channel diversity
      const uniqueChannels = Array.from(new Set(videos.map(v => v.channelTitle)));
      const isNiche = uniqueChannels.length <= 2;

      // Generate insights
      let insights = [];
      if (avgViews > 2000000) insights.push("높은 조회수 잠재력");
      if (avgEngagement > 5) insights.push("높은 참여율");
      if (isNiche) insights.push("특정 채널 특화");
      else insights.push("다양한 채널에서 성공");

      const descriptions = {
        '요리/레시피': "간단하고 실용적인 레시피가 인기. 시간 단축과 집에서 쉽게 만들 수 있는 점이 핵심",
        '건강/다이어트': "단기간 효과와 일상 루틴이 강조. 챌린지 형태의 콘텐츠가 높은 참여도",
        '일상/브이로그': "진정성 있는 일상 공유와 시청자와의 공감대 형성이 중요",
        '뷰티/패션': "트렌드 반영과 실용적인 팁 제공. 제품 리뷰와 하울 콘텐츠가 효과적",
        '게임/엔터테인먼트': "재미있는 상황과 도전 요소. 시청자 참여를 유도하는 인터랙티브 요소",
        '교육/정보': "명확한 정보 전달과 실용성. 단계별 설명과 꿀팁 제공이 핵심"
      };

      let patternDesc = descriptions[category] || "다양한 접근 방식으로 시청자 관심 유도";
      if (insights.includes("높은 조회수 잠재력")) patternDesc += ". 바이럴 가능성 높음";
      if (insights.includes("높은 참여율")) patternDesc += ". 시청자 참여도 우수";

      return {
        theme: category,
        pattern: patternDesc,
        videos: videos.sort((a, b) => b.viewCount - a.viewCount),
        keywords: frequentWords,
        avgViews: Math.round(avgViews),
        successFactors: insights,
        engagementRate: avgEngagement.toFixed(2),
        channelDiversity: uniqueChannels.length
      };
    })
    .sort((a, b) => b.avgViews - a.avgViews);

  return patterns;
}

// Generate comprehensive title analysis insights
function generateTitleInsights(videos: any[]): any {
  const allTitles = videos.map(v => v.title);
  
  // Extract common keywords and phrases
  const wordFrequency = new Map();
  const phraseFrequency = new Map();
  
  allTitles.forEach(title => {
    // Clean and split title into words
    const words = title.toLowerCase()
      .replace(/[^\w가-힣\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 1);
    
    // Count individual words
    words.forEach(word => {
      wordFrequency.set(word, (wordFrequency.get(word) || 0) + 1);
    });
    
    // Extract 2-3 word phrases
    for (let i = 0; i < words.length - 1; i++) {
      const phrase2 = words.slice(i, i + 2).join(' ');
      const phrase3 = words.slice(i, i + 3).join(' ');
      
      if (phrase2.length > 3) {
        phraseFrequency.set(phrase2, (phraseFrequency.get(phrase2) || 0) + 1);
      }
      if (i < words.length - 2 && phrase3.length > 5) {
        phraseFrequency.set(phrase3, (phraseFrequency.get(phrase3) || 0) + 1);
      }
    }
  });
  
  // Get top keywords (appearing in 2+ videos)
  const topKeywords = Array.from(wordFrequency.entries())
    .filter(([word, count]) => count >= 2 && word.length > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([word, count]) => ({ word, count, percentage: Math.round((count / videos.length) * 100) }));
  
  // Get top phrases (appearing in 2+ videos)
  const topPhrases = Array.from(phraseFrequency.entries())
    .filter(([phrase, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([phrase, count]) => ({ phrase, count, percentage: Math.round((count / videos.length) * 100) }));
  
  // Analyze title patterns
  const patterns = {
    hasNumbers: allTitles.filter(title => /\d+/.test(title)).length,
    hasEmojis: allTitles.filter(title => /[\uD83C-\uDBFF\uDC00-\uDFFF]/.test(title)).length,
    hasExclamation: allTitles.filter(title => title.includes('!')).length,
    hasQuestion: allTitles.filter(title => title.includes('?')).length,
    hasHashtags: allTitles.filter(title => title.includes('#')).length,
    hasNegatives: allTitles.filter(title => /절대|안|금지|위험|조심/.test(title)).length,
    hasSuperlatives: allTitles.filter(title => /최고|최대|가장|완전|대박/.test(title)).length,
    hasUrgency: allTitles.filter(title => /지금|바로|즉시|당장|빨리/.test(title)).length
  };
  
  // Generate actionable insights
  const insights = [];
  
  if (patterns.hasNumbers / videos.length > 0.3) {
    insights.push(`숫자 활용 효과적 (${Math.round(patterns.hasNumbers / videos.length * 100)}% 사용) - "3가지", "10분", "90세" 등`);
  }
  
  if (patterns.hasNegatives / videos.length > 0.2) {
    insights.push(`경고/금지 표현 인기 (${Math.round(patterns.hasNegatives / videos.length * 100)}% 사용) - "절대 안", "조심" 등`);
  }
  
  if (patterns.hasExclamation / videos.length > 0.4) {
    insights.push(`감탄사 효과적 (${Math.round(patterns.hasExclamation / videos.length * 100)}% 사용) - 강조와 관심 유도`);
  }
  
  if (patterns.hasUrgency / videos.length > 0.1) {
    insights.push(`긴급성 표현 활용 (${Math.round(patterns.hasUrgency / videos.length * 100)}% 사용) - 즉시성 어필`);
  }
  
  // Most successful title characteristics
  const avgViews = videos.reduce((sum, v) => sum + v.viewCount, 0) / videos.length;
  const topVideos = videos.sort((a, b) => b.viewCount - a.viewCount).slice(0, 3);
  
  return {
    topKeywords,
    topPhrases,
    patterns,
    insights,
    recommendations: [
      `가장 인기 키워드: ${topKeywords.slice(0, 3).map(k => k.word).join(', ')}`,
      `효과적인 제목 패턴: ${topPhrases.slice(0, 2).map(p => `"${p.phrase}"`).join(', ')}`,
      `${Math.round(patterns.hasNumbers / videos.length * 100)}%가 숫자 사용 - 구체적 수치 포함 권장`,
      `${Math.round(patterns.hasNegatives / videos.length * 100)}%가 경고 표현 - 호기심 자극 효과적`
    ],
    topPerformingTitles: topVideos.map(v => ({
      title: v.title,
      viewCount: v.viewCount,
      channelTitle: v.channelTitle
    }))
  };
}

// Generate hybrid analysis comparison using OpenAI
async function generateHybridAnalysis(establishedChannels: any[], newChannels: any[], keyword: string) {
  try {
    const establishedTitles = establishedChannels.map(v => v.title).join('\n');
    const newTitles = newChannels.map(v => v.title).join('\n');
    
    const prompt = `키워드 "${keyword}"에 대한 하이브리드 채널 분석을 수행해주세요.

기존 성공 채널들의 제목들:
${establishedTitles}

신규 급성장 채널들의 제목들:
${newTitles}

다음 JSON 형식으로 비교 분석 결과를 제공해주세요:
{
  "establishedPatterns": {
    "keywords": ["키워드1", "키워드2"],
    "titlePatterns": ["패턴1", "패턴2"],
    "strengths": ["강점1", "강점2"]
  },
  "newChannelPatterns": {
    "keywords": ["키워드1", "키워드2"],
    "titlePatterns": ["패턴1", "패턴2"],
    "innovations": ["혁신점1", "혁신점2"]
  },
  "keyDifferences": [
    "차이점1",
    "차이점2"
  ],
  "opportunities": [
    "기회1: 설명",
    "기회2: 설명"
  ],
  "recommendations": [
    "권장사항1",
    "권장사항2"
  ],
  "marketInsights": [
    "시장 인사이트1",
    "시장 인사이트2"
  ]
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o", // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
      messages: [
        {
          role: "system",
          content: "당신은 YouTube 콘텐츠 분석 전문가입니다. 기존 채널과 신규 채널의 패턴을 비교 분석하여 실용적인 인사이트를 제공해주세요."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.7
    });

    return JSON.parse(response.choices[0].message.content || "{}");
  } catch (error) {
    console.error("Error generating hybrid analysis:", error);
    return {
      establishedPatterns: { keywords: [], titlePatterns: [], strengths: [] },
      newChannelPatterns: { keywords: [], titlePatterns: [], innovations: [] },
      keyDifferences: ["분석 중 오류가 발생했습니다."],
      opportunities: [],
      recommendations: ["다시 시도해주세요."],
      marketInsights: []
    };
  }
}

// Analyze viral video titles for patterns and insights
async function analyzeViralTitles(videos: any[]): Promise<any> {
  if (videos.length === 0) return null;

  try {
    const titles = videos.map(v => v.title).join('\n');
    
    const prompt = `다음은 100만 조회수 이상을 기록한 바이럴 YouTube 영상들의 제목 목록입니다:

${titles}

이 제목들을 분석하여 다음 JSON 형식으로 결과를 제공해주세요:
{
  "commonWords": [
    {"word": "키워드", "count": 숫자, "percentage": 퍼센트}
  ],
  "commonPhrases": [
    {"phrase": "반복되는 문구", "count": 숫자, "percentage": 퍼센트}
  ],
  "titlePatterns": {
    "hasNumbers": 숫자포함_개수,
    "hasQuestions": 질문형_개수,
    "hasExclamations": 느낌표_개수,
    "hasEmojis": 이모지_개수,
    "avgLength": 평균_글자수
  },
  "insights": [
    "바이럴 제목의 특징 인사이트 1",
    "바이럴 제목의 특징 인사이트 2"
  ],
  "recommendations": [
    "제목 최적화 권장사항 1",
    "제목 최적화 권장사항 2"
  ]
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "당신은 YouTube 콘텐츠 분석 전문가입니다. 바이럴 영상 제목의 패턴을 분석하여 실용적인 인사이트를 제공해주세요."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.7
    });

    return JSON.parse(response.choices[0].message.content || "{}");
  } catch (error) {
    console.error("Error analyzing titles:", error);
    return {
      commonWords: [],
      commonPhrases: [],
      titlePatterns: { hasNumbers: 0, hasQuestions: 0, hasExclamations: 0, hasEmojis: 0, avgLength: 0 },
      insights: ["제목 분석 중 오류가 발생했습니다."],
      recommendations: ["다시 시도해주세요."]
    };
  }
}

// Analyze thumbnails for visual patterns
async function analyzeThumbnails(videos: any[]): Promise<any> {
  if (videos.length === 0) return null;

  try {
    const thumbnailUrls = videos.slice(0, 20).map(v => v.thumbnailUrl).filter(url => url);
    
    const prompt = `다음은 100만 조회수 이상을 기록한 바이럴 YouTube 영상들의 썸네일 이미지 URL 목록입니다:

${thumbnailUrls.join('\n')}

이 썸네일들의 시각적 패턴을 분석하여 다음 JSON 형식으로 결과를 제공해주세요:
{
  "colorPatterns": [
    {"color": "#FF0000", "usage": 사용횟수, "percentage": 퍼센트}
  ],
  "visualElements": [
    {"element": "시각적_요소명", "frequency": 빈도, "description": "설명"}
  ],
  "designTrends": [
    {"trend": "디자인_트렌드", "impact": "영향도", "examples": ["예시1", "예시2"]}
  ],
  "insights": [
    "썸네일 분석 인사이트 1",
    "썸네일 분석 인사이트 2"
  ]
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "당신은 YouTube 썸네일 디자인 전문가입니다. 바이럴 영상 썸네일의 시각적 패턴을 분석하여 실용적인 디자인 인사이트를 제공해주세요."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.7
    });

    return JSON.parse(response.choices[0].message.content || "{}");
  } catch (error) {
    console.error("Error analyzing thumbnails:", error);
    return {
      colorPatterns: [],
      visualElements: [],
      designTrends: [],
      insights: ["썸네일 분석 중 오류가 발생했습니다."]
    };
  }
}

function isShoppingChannel(channel: any): boolean {
  const title = channel.snippet?.title?.toLowerCase() || '';
  const description = channel.snippet?.description?.toLowerCase() || '';
  
  // Shopping-related keywords in Korean and English
  const shoppingKeywords = [
    // Korean shopping terms
    '쇼핑', '구매', '판매', '할인', '세일', '특가', '가격', '리뷰', '상품', '제품',
    '브랜드', '온라인몰', '마켓', '스토어', '구입', '주문', '배송', '무료배송',
    '추천템', '득템', '언박싱', '착용샷', '코디', '패션', '뷰티', '화장품',
    
    // English shopping terms
    'shop', 'shopping', 'buy', 'purchase', 'sale', 'discount', 'price', 'review',
    'product', 'brand', 'store', 'market', 'unboxing', 'haul', 'affiliate',
    'sponsored', 'ad', 'promo', 'deal', 'offer', 'fashion', 'beauty'
  ];
  
  // Check if channel title or description contains shopping keywords
  const hasShoppingKeywords = shoppingKeywords.some(keyword => 
    title.includes(keyword) || description.includes(keyword)
  );
  
  // Additional patterns for shopping channels
  const shoppingPatterns = [
    /리뷰.*채널/,
    /상품.*소개/,
    /쇼핑.*추천/,
    /할인.*정보/,
    /특가.*알림/,
    /.*쇼핑몰/,
    /.*마켓/,
    /.*스토어/,
    /unboxing/i,
    /product.*review/i,
    /shopping.*haul/i
  ];
  
  const hasShoppingPattern = shoppingPatterns.some(pattern => 
    pattern.test(title) || pattern.test(description)
  );
  
  return hasShoppingKeywords || hasShoppingPattern;
}

async function filterVideosByAgeGroup(videos: any[], ageGroup: string): Promise<any[]> {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    
    // Process videos in batches to avoid token limits
    const batchSize = 20;
    const filteredVideos: any[] = [];
    
    for (let i = 0; i < videos.length; i += batchSize) {
      const batch = videos.slice(i, i + batchSize);
      
      const videoData = batch.map(v => ({
        videoId: v.videoId,
        title: v.title,
        channelTitle: v.channelTitle,
        description: v.description?.substring(0, 200) || "",
        tags: v.tags?.slice(0, 5) || []
      }));

      const response = await openai.chat.completions.create({
        model: "gpt-4o", // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
        messages: [
          {
            role: "system",
            content: `당신은 YouTube 콘텐츠 분석 전문가입니다. ${ageGroup} 연령층에 적합한 영상을 필터링해주세요. 
            
${ageGroup} 특성:
- 10대: 게임, 엔터테인먼트, K-POP, 학교생활, 트렌드
- 20대: 취업, 연애, 자기계발, 여행, 맛집, 운동
- 30대: 육아, 결혼, 부동산, 투자, 건강, 요리
- 40대: 자녀교육, 건강관리, 재테크, 취미, 가족
- 50대: 건강, 투자, 은퇴준비, 여행, 전통문화
- 60대 이상: 건강관리, 손자녀, 전통, 취미, 종교

각 영상의 적합성을 0-100점으로 평가하고, 70점 이상만 선택해주세요.`
          },
          {
            role: "user",
            content: `다음 영상들을 ${ageGroup}에 맞게 필터링해주세요:\n\n${JSON.stringify(videoData, null, 2)}\n\n결과를 JSON 형식으로 제공해주세요: { "suitableVideos": [{"videoId": "ID", "score": 85, "reason": "이유"}] }`
          }
        ],
        response_format: { type: "json_object" },
      });

      const result = JSON.parse(response.choices[0].message.content || "{}");
      const suitableVideoIds = new Set(
        result.suitableVideos?.map((v: any) => v.videoId) || []
      );
      
      // Add suitable videos to filtered results
      const batchFiltered = batch.filter(video => 
        suitableVideoIds.has(video.videoId)
      );
      filteredVideos.push(...batchFiltered);
    }
    
    console.log(`Filtered ${videos.length} videos to ${filteredVideos.length} videos suitable for ${ageGroup}`);
    return filteredVideos;
    
  } catch (error) {
    console.error('Age filtering error:', error);
    // Return original videos if filtering fails
    return videos;
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Search YouTube videos
  app.post("/api/search", async (req, res) => {
    try {
      const params = searchParamsSchema.parse(req.body);
      const { ageGroup, ...searchParams } = params;
      let videos = await searchYouTubeVideos(searchParams);
      
      // Apply age-specific filtering if ageGroup is provided
      if (ageGroup) {
        videos = await filterVideosByAgeGroup(videos, ageGroup);
      }
      
      // Store videos in our database
      for (const video of videos) {
        const existingVideo = await storage.getVideo(video.videoId);
        if (!existingVideo) {
          await storage.createVideo(video);
        }
      }

      res.json({ 
        videos,
        summary: {
          total: videos.length,
          great: videos.filter(v => v.performanceLevel === "great").length,
          good: videos.filter(v => v.performanceLevel === "good").length,
          normal: videos.filter(v => v.performanceLevel === "normal").length
        }
      });
    } catch (error) {
      console.error("Search error:", error);
      res.status(500).json({ message: error instanceof Error ? error.message : "Search failed" });
    }
  });

  // Apply Great filter
  app.post("/api/filter-great", async (req, res) => {
    try {
      const { videos } = req.body;
      const greatVideos = videos.filter((video: any) => 
        isGreatVideo(video.viewCount, video.subscriberCount)
      );
      
      res.json({ videos: greatVideos });
    } catch (error) {
      res.status(500).json({ message: "Filter failed" });
    }
  });

  // Advanced viral content analysis with NLP clustering
  app.post("/api/analyze-channels-viral", async (req, res) => {
    try {
      const { channelIds } = req.body;
      const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_KEY || "";
      
      if (!YOUTUBE_API_KEY) {
        throw new Error("YouTube API key not found");
      }

      if (!channelIds || channelIds.length === 0) {
        return res.json({ 
          viralPatterns: [],
          channelAnalysis: [],
          summary: { totalVideos: 0, channels: 0, viralVideos: 0 }
        });
      }

      let allViralVideos: Array<{
        videoId: string;
        title: string;
        channelTitle: string;
        channelId: string;
        channelCreatedAt: Date;
        viewCount: number;
        subscriberCount: number;
        thumbnailUrl: string;
        description: string;
        tags: string[];
        publishedAt: Date;
      }> = [];

      // Analyze each selected channel for viral content
      for (const channelId of channelIds) {
        try {
          // Search for all videos from this channel (not just shorts)
          const searchResponse = await fetch(`https://www.googleapis.com/youtube/v3/search?${new URLSearchParams({
            key: YOUTUBE_API_KEY,
            part: "snippet",
            channelId: channelId,
            type: "video",
            order: "viewCount",
            maxResults: "50"
          })}`);
          const searchData = await searchResponse.json();

          if (searchData.items && searchData.items.length > 0) {
            // Get video statistics and details
            const videoIds = searchData.items.map((item: any) => item.id.videoId).join(",");
            const statsResponse = await fetch(`https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({
              key: YOUTUBE_API_KEY,
              part: "statistics,snippet",
              id: videoIds
            })}`);
            const statsData = await statsResponse.json();

            // Get channel info
            const channelResponse = await fetch(`https://www.googleapis.com/youtube/v3/channels?${new URLSearchParams({
              key: YOUTUBE_API_KEY,
              part: "statistics,snippet",
              id: channelId
            })}`);
            const channelData = await channelResponse.json();
            const channel = channelData.items?.[0];

            if (channel) {
              searchData.items.forEach((item: any, index: number) => {
                const stats = statsData.items[index]?.statistics || {};
                const videoDetails = statsData.items[index]?.snippet || {};
                const viewCount = parseInt(stats.viewCount || "0");

                // Filter for viral videos (1M+ views)
                if (viewCount >= 1000000) {
                  allViralVideos.push({
                    videoId: item.id.videoId,
                    title: item.snippet.title,
                    channelTitle: item.snippet.channelTitle,
                    channelId: item.snippet.channelId,
                    channelCreatedAt: new Date(channel.snippet.publishedAt),
                    viewCount,
                    subscriberCount: parseInt(channel.statistics.subscriberCount || "0"),
                    thumbnailUrl: item.snippet.thumbnails.medium.url,
                    description: videoDetails.description || item.snippet.description || "",
                    tags: videoDetails.tags || [],
                    publishedAt: new Date(item.snippet.publishedAt)
                  });
                }
              });
            }
          }
        } catch (error) {
          console.error(`Error analyzing channel ${channelId}:`, error);
        }
      }

      // AI-powered topic clustering using OpenAI
      let viralPatterns: Array<{
        theme: string;
        pattern: string;
        videos: typeof allViralVideos;
        keywords: string[];
        avgViews: number;
      }> = [];

      if (allViralVideos.length > 0 && openai.apiKey) {
        try {
          // Prepare video data for AI analysis
          const videoData = allViralVideos.map(v => ({
            title: v.title,
            description: v.description.substring(0, 200), // Limit description length
            tags: v.tags.slice(0, 5), // Limit tags
            viewCount: v.viewCount,
            channelTitle: v.channelTitle
          }));

          const clusteringPrompt = `
            다음 YouTube 바이럴 영상들(100만 조회수 이상)을 분석하여 주제별로 클러스터링해주세요.
            각 영상의 제목, 설명, 태그를 기반으로 공통 주제나 패턴을 찾아 그룹화해주세요.

            영상 데이터:
            ${JSON.stringify(videoData, null, 2)}

            다음 JSON 형식으로 응답해주세요:
            {
              "clusters": [
                {
                  "theme": "주제명 (예: 요리 레시피, 게임 공략, 일상 브이로그 등)",
                  "pattern": "패턴 설명 (예: 빠른 요리법, 초보자 가이드, 힐링 콘텐츠 등)",
                  "keywords": ["키워드1", "키워드2", "키워드3"],
                  "videoIndices": [0, 3, 7] // 해당 클러스터에 속하는 영상들의 인덱스
                }
              ]
            }

            최대 8개의 클러스터로 분류해주세요.
          `;

          const response = await openai.chat.completions.create({
            model: "gpt-4o", // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
            messages: [
              {
                role: "system",
                content: "당신은 YouTube 콘텐츠 분석 전문가입니다. 영상 제목, 설명, 태그를 분석하여 의미있는 주제별 클러스터를 만드는 것이 목표입니다."
              },
              {
                role: "user",
                content: clusteringPrompt
              }
            ],
            response_format: { type: "json_object" },
            temperature: 0.3
          });

          const clustering = JSON.parse(response.choices[0].message.content || "{}");
          
          if (clustering.clusters) {
            viralPatterns = clustering.clusters.map((cluster: any) => {
              const clusterVideos = cluster.videoIndices.map((index: number) => allViralVideos[index]).filter(Boolean);
              const avgViews = clusterVideos.length > 0 
                ? Math.round(clusterVideos.reduce((sum: number, v: any) => sum + v.viewCount, 0) / clusterVideos.length)
                : 0;
              
              return {
                theme: cluster.theme,
                pattern: cluster.pattern,
                videos: clusterVideos,
                keywords: cluster.keywords || [],
                avgViews
              };
            }).filter((pattern: any) => pattern.videos.length > 0);
          }
        } catch (aiError) {
          console.error("AI clustering failed, falling back to advanced content analysis:", aiError);
          
          // Advanced content analysis without OpenAI
          viralPatterns = performAdvancedContentAnalysis(allViralVideos);
        }
      }

      // Channel analysis summary
      const channelAnalysis = Array.from(
        new Map(allViralVideos.map(v => [v.channelId, v])).values()
      ).map(video => ({
        channelTitle: video.channelTitle,
        channelCreatedAt: video.channelCreatedAt,
        subscriberCount: video.subscriberCount,
        viralVideoCount: allViralVideos.filter(v => v.channelId === video.channelId).length,
        maxViews: Math.max(...allViralVideos.filter(v => v.channelId === video.channelId).map(v => v.viewCount))
      }));

      res.json({
        viralPatterns,
        channelAnalysis,
        summary: {
          totalVideos: allViralVideos.length,
          channels: channelIds.length,
          viralVideos: allViralVideos.length
        }
      });

    } catch (error) {
      console.error("Channel viral analysis error:", error);
      res.status(500).json({ message: error instanceof Error ? error.message : "Analysis failed" });
    }
  });

  // Generate AI analysis
  app.post("/api/ai-analysis", async (req, res) => {
    try {
      const { videoId, title, description, tags } = req.body;

      if (!openai.apiKey) {
        return res.status(500).json({ message: "OpenAI API key not configured" });
      }

      const prompt = `
        다음 YouTube 영상 정보를 분석하여 한국어로 답변해주세요:
        
        제목: ${title}
        설명: ${description}
        태그: ${tags?.join(", ") || "없음"}
        
        다음 형식의 JSON으로 응답해주세요:
        {
          "trends": ["트렌드 분석 항목1", "트렌드 분석 항목2", "트렌드 분석 항목3"],
          "targets": ["타깃 관객1", "타깃 관객2", "타깃 관객3"],
          "hooks": ["후킹 포인트1", "후킹 포인트2", "후킹 포인트3"],
          "suggestedTitles": ["제안 제목1", "제안 제목2", "제안 제목3", "제안 제목4", "제안 제목5"]
        }
      `;

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "당신은 YouTube 콘텐츠 분석 전문가입니다. 주어진 영상 정보를 바탕으로 트렌드, 타깃 관객, 후킹 포인트, 제목 제안을 분석해주세요."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0.7
      });

      const analysis = JSON.parse(response.choices[0].message.content || "{}");
      
      const aiAnalysis = await storage.createAIAnalysis({
        videoId,
        trends: analysis.trends,
        targets: analysis.targets,
        hooks: analysis.hooks,
        suggestedTitles: analysis.suggestedTitles
      });

      res.json(analysis);
    } catch (error) {
      console.error("AI analysis error:", error);
      res.status(500).json({ message: "AI 분석 중 오류가 발생했습니다." });
    }
  });

  // Generate script
  app.post("/api/generate-script", async (req, res) => {
    try {
      const scriptOptions = z.object({
        format: z.enum(["shorts", "short", "long"]),
        tone: z.enum(["friendly", "professional", "casual", "enthusiastic"]),
        keywords: z.string().optional(),
        audience: z.string().optional(),
        title: z.string()
      }).parse(req.body);

      if (!openai.apiKey) {
        return res.status(500).json({ message: "OpenAI API key not configured" });
      }

      const formatMap = {
        shorts: "60초 이하의 YouTube 쇼츠",
        short: "5분 이하의 짧은 영상",
        long: "10분 이상의 롱폼 영상"
      };

      const toneMap = {
        friendly: "친근하고 따뜻한",
        professional: "전문적이고 신뢰감 있는",
        casual: "편안하고 자연스러운",
        enthusiastic: "열정적이고 활기찬"
      };

      const prompt = `
        다음 조건에 맞는 YouTube 영상 대본을 한국어로 작성해주세요:
        
        형식: ${formatMap[scriptOptions.format]}
        톤: ${toneMap[scriptOptions.tone]}
        제목: ${scriptOptions.title}
        키워드: ${scriptOptions.keywords || "없음"}
        타겟 관객: ${scriptOptions.audience || "일반"}
        
        대본은 다음 구조로 작성해주세요:
        1. 인트로 (후킹)
        2. 메인 콘텐츠
        3. 마무리 (구독 유도)
        
        시청자의 관심을 끌고 끝까지 시청하게 만드는 매력적인 대본을 작성해주세요.
      `;

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "당신은 YouTube 콘텐츠 대본 작성 전문가입니다. 시청자의 관심을 끌고 높은 완주율을 달성할 수 있는 매력적인 대본을 작성합니다."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.7
      });

      const scriptContent = response.choices[0].message.content || "";
      
      const script = await storage.createScript({
        title: scriptOptions.title,
        content: scriptContent,
        format: scriptOptions.format,
        tone: scriptOptions.tone,
        keywords: scriptOptions.keywords,
        audience: scriptOptions.audience
      });

      res.json({ content: scriptContent, id: script.id });
    } catch (error) {
      console.error("Script generation error:", error);
      res.status(500).json({ message: "대본 생성 중 오류가 발생했습니다." });
    }
  });

  // Get user scripts
  app.get("/api/scripts", async (req, res) => {
    try {
      const scripts = await storage.getUserScripts();
      res.json(scripts);
    } catch (error) {
      res.status(500).json({ message: "스크립트 조회 실패" });
    }
  });

  // Extract transcript
  app.post("/api/extract-transcript", async (req, res) => {
    try {
      const { videoId } = req.body;
      const transcript = await extractVideoTranscript(videoId);
      res.json({ videoId, transcript });
    } catch (error) {
      console.error("Transcript extraction error:", error);
      res.status(500).json({ message: error instanceof Error ? error.message : "대본 추출 실패" });
    }
  });

  // Trending topics analysis
  app.get("/api/trending-topics", async (req, res) => {
    try {
      const { getTrendingTopics } = await import("./trending-api");
      const trendingData = await getTrendingTopics();
      res.json(trendingData);
    } catch (error) {
      console.error("Trending topics error:", error);
      res.status(500).json({ message: "트렌딩 주제 분석 실패" });
    }
  });

  // Create HTTP server
  const server = createServer(app);

  // Transcript extraction helper functions
  async function extractVideoTranscript(videoId: string): Promise<string> {
    try {
      const transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'ko' });
      return transcript.map(item => item.text).join(' ');
    } catch (error) {
      console.error("Korean transcript not found, trying English:", error);
      try {
        const transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
        return transcript.map(item => item.text).join(' ');
      } catch (englishError) {
        console.error("English transcript not found, trying auto-generated:", englishError);
        try {
          const transcript = await YoutubeTranscript.fetchTranscript(videoId);
          return transcript.map(item => item.text).join(' ');
        } catch (autoError) {
          throw new Error("자막을 찾을 수 없습니다. 이 영상에는 자막이 없거나 비공개 상태일 수 있습니다.");
        }
      }
    }
  }

  // Analyze new channels for viral patterns
  app.post("/api/analyze-new-channels", async (req, res) => {
    try {
      const { keyword, excludeKeywords } = req.body;
      console.log(`Analyzing new channels for keyword: ${keyword}`);

      if (!keyword) {
        return res.status(400).json({ error: "키워드가 필요합니다" });
      }

      const YOUTUBE_API_KEY = getCurrentYouTubeApiKey();
      if (!YOUTUBE_API_KEY) {
        return res.status(500).json({ 
          error: "사용 가능한 YouTube API 키가 없습니다",
          viralPatterns: [],
          channelAnalysis: [],
          titleInsights: {
            topKeywords: [],
            topPhrases: [],
            insights: ["사용 가능한 YouTube API 키가 없습니다."],
            recommendations: ["설정 페이지에서 새로운 YouTube API 키를 추가해주세요."],
            topPerformingTitles: []
          },
          summary: { totalVideos: 0, newChannels: 0, viralVideos: 0 }
        });
      }

      // Search for videos with the keyword
      const searchUrl = "https://www.googleapis.com/youtube/v3/search";
      const searchParams = new URLSearchParams({
        key: YOUTUBE_API_KEY,
        part: "snippet",
        q: keyword,
        type: "video",
        order: "viewCount",
        maxResults: "50",
        publishedAfter: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
      });

      const searchResponse = await fetch(`${searchUrl}?${searchParams}`);
      const searchData = await searchResponse.json();
      
      console.log('YouTube API Response Status:', searchResponse.status);
      console.log('YouTube API Response:', JSON.stringify(searchData, null, 2));

      // Check for API errors (quota exceeded, invalid key, etc.)
      if (searchData.error) {
        console.error('YouTube API Error:', searchData.error);
        
        // Mark current key as exceeded and try next one
        if (searchData.error.reason === 'quotaExceeded') {
          apiKeyManager.markKeyAsExceeded(YOUTUBE_API_KEY);
          const nextKey = apiKeyManager.getActiveKey();
          
          if (nextKey && nextKey !== YOUTUBE_API_KEY) {
            console.log('Switching to next available API key...');
            // Retry with new key - but for now just inform user
            return res.json({
              viralPatterns: [],
              channelAnalysis: [],
              titleInsights: {
                topKeywords: [],
                topPhrases: [],
                insights: ['현재 API 키의 할당량이 초과되었습니다. 다음 키로 자동 전환되었습니다.'],
                recommendations: ['페이지를 새로고침하고 다시 시도해주세요. 또는 설정에서 추가 API 키를 등록하세요.'],
                topPerformingTitles: []
              },
              summary: {
                totalVideos: 0,
                newChannels: 0,
                viralVideos: 0,
                error: 'API 키 전환됨'
              }
            });
          }
        }
        
        return res.json({
          viralPatterns: [],
          channelAnalysis: [],
          titleInsights: {
            topKeywords: [],
            topPhrases: [],
            insights: [`YouTube API 오류: ${searchData.error.message}`],
            recommendations: ['새로운 YouTube API 키가 필요하거나 일일 할당량을 초과했습니다.'],
            topPerformingTitles: []
          },
          summary: {
            totalVideos: 0,
            newChannels: 0,
            viralVideos: 0,
            error: 'API 한도 초과 또는 키 문제'
          }
        });
      }

      if (!searchData.items || searchData.items.length === 0) {
        return res.json({
          viralPatterns: [],
          channelAnalysis: [],
          titleInsights: {
            topKeywords: [],
            topPhrases: [],
            insights: ['해당 키워드로 검색된 영상이 없습니다.'],
            recommendations: ['다른 키워드로 검색해보세요.'],
            topPerformingTitles: []
          },
          summary: { totalVideos: 0, newChannels: 0, viralVideos: 0 }
        });
      }

      // Get video statistics
      const videoIds = searchData.items.map((item: any) => item.id.videoId).join(",");
      const statsResponse = await fetch(`https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({
        key: YOUTUBE_API_KEY,
        part: "statistics,snippet",
        id: videoIds
      })}`);
      const statsData = await statsResponse.json();

      // Get channel information
      const channelIds = searchData.items.map((item: any) => item.snippet.channelId);
      const uniqueChannelIds = [...new Set(channelIds)].join(",");
      const channelResponse = await fetch(`https://www.googleapis.com/youtube/v3/channels?${new URLSearchParams({
        key: YOUTUBE_API_KEY,
        part: "statistics,snippet",
        id: uniqueChannelIds
      })}`);
      const channelData = await channelResponse.json();

      // Filter for viral videos from new channels and collect all viral videos per channel
      const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const viralVideos: any[] = [];
      const newChannelsSet = new Set();

      // First pass: identify new channels with viral videos
      searchData.items.forEach((item: any, index: number) => {
        const stats = statsData.items[index]?.statistics || {};
        const channel = channelData.items.find((ch: any) => ch.id === item.snippet.channelId);
        
        if (!channel) return;

        const channelCreatedAt = new Date(channel.snippet.publishedAt);
        const viewCount = parseInt(stats.viewCount || "0");

        // Check if channel is new (within 3 months) and video is viral (1M+ views)
        if (channelCreatedAt >= threeMonthsAgo && viewCount >= 1000000) {
          newChannelsSet.add(item.snippet.channelId);
        }
      });

      // Second pass: collect ALL viral videos from identified new channels
      for (const channelId of Array.from(newChannelsSet) as string[]) {
        try {
          // Search for all videos from this new channel
          const channelSearchResponse = await fetch(`https://www.googleapis.com/youtube/v3/search?${new URLSearchParams({
            key: YOUTUBE_API_KEY,
            part: "snippet",
            channelId: channelId as string,
            type: "video",
            order: "viewCount",
            maxResults: "50"
          })}`);
          const channelSearchData = await channelSearchResponse.json();

          if (channelSearchData.items && channelSearchData.items.length > 0) {
            // Get statistics for all videos from this channel
            const channelVideoIds = channelSearchData.items.map((item: any) => item.id.videoId).join(",");
            const channelStatsResponse = await fetch(`https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({
              key: YOUTUBE_API_KEY,
              part: "statistics,snippet",
              id: channelVideoIds
            })}`);
            const channelStatsData = await channelStatsResponse.json();

            const channel = channelData.items.find((ch: any) => ch.id === channelId);
            
            channelSearchData.items.forEach((item: any, index: number) => {
              const stats = channelStatsData.items[index]?.statistics || {};
              const videoSnippet = channelStatsData.items[index]?.snippet || {};
              const viewCount = parseInt(stats.viewCount || "0");

              // Include ALL videos with 1M+ views from this new channel
              if (viewCount >= 1000000) {
                viralVideos.push({
                  videoId: item.id.videoId,
                  title: item.snippet.title,
                  channelTitle: item.snippet.channelTitle,
                  channelId: item.snippet.channelId,
                  channelCreatedAt: new Date(channel.snippet.publishedAt),
                  viewCount,
                  subscriberCount: parseInt(channel.statistics.subscriberCount || "0"),
                  thumbnailUrl: item.snippet.thumbnails.medium.url,
                  description: videoSnippet.description || item.snippet.description || "",
                  tags: videoSnippet.tags || [],
                  publishedAt: new Date(item.snippet.publishedAt)
                });
              }
            });
          }
        } catch (error) {
          console.error(`Error fetching videos for channel ${channelId}:`, error);
        }
      }

      // Use advanced content analysis for viral patterns
      let viralPatterns = [];
      if (viralVideos.length > 0) {
        viralPatterns = performAdvancedContentAnalysis(viralVideos);
      }

      // Generate comprehensive title analysis insights
      let titleInsights = {};
      if (viralVideos.length > 0) {
        titleInsights = generateTitleInsights(viralVideos);
      }

      // Channel analysis summary with detailed video lists
      const channelAnalysis = Array.from(
        new Map(viralVideos.map(v => [v.channelId, v])).values()
      ).map((video: any) => {
        const channelViralVideos = viralVideos.filter(v => v.channelId === video.channelId);
        return {
          channelTitle: video.channelTitle,
          channelCreatedAt: video.channelCreatedAt,
          subscriberCount: video.subscriberCount,
          viralVideoCount: channelViralVideos.length,
          maxViews: Math.max(...channelViralVideos.map(v => v.viewCount)),
          viralVideos: channelViralVideos.map(v => ({
            title: v.title,
            viewCount: v.viewCount,
            videoId: v.videoId,
            publishedAt: v.publishedAt
          })).sort((a, b) => b.viewCount - a.viewCount)
        };
      }).sort((a, b) => b.viralVideoCount - a.viralVideoCount);

      // Apply exclude keywords filtering
      let filteredViralVideos = viralVideos;
      if (excludeKeywords) {
        const excludeKeywordsList = excludeKeywords.split(',').map((k: string) => k.trim().toLowerCase()).filter((k: string) => k.length > 0);
        console.log('Exclude keywords for viral analysis:', excludeKeywordsList);
        
        if (excludeKeywordsList.length > 0) {
          const beforeCount = viralVideos.length;
          filteredViralVideos = viralVideos.filter(video => {
            const titleLower = video.title.toLowerCase();
            const descriptionLower = (video.description || '').toLowerCase();
            const channelTitleLower = video.channelTitle.toLowerCase();
            
            const shouldExclude = excludeKeywordsList.some(excludeKeyword => 
              titleLower.includes(excludeKeyword) || 
              descriptionLower.includes(excludeKeyword) ||
              channelTitleLower.includes(excludeKeyword)
            );
            
            if (shouldExclude) {
              console.log(`Filtering out viral video: "${video.title}" (contains excluded keyword)`);
            }
            
            return !shouldExclude;
          });
          console.log(`Viral videos filtered: ${beforeCount} -> ${filteredViralVideos.length}`);
        }
      }

      // Update viral patterns with filtered videos
      const filteredViralPatterns = viralPatterns.map(pattern => ({
        ...pattern,
        videos: pattern.videos.filter((video: any) => 
          filteredViralVideos.some(fv => fv.videoId === video.videoId)
        )
      })).filter(pattern => pattern.videos.length > 0);

      // Regenerate title insights and channel analysis with filtered data
      let filteredTitleInsights = {};
      if (filteredViralVideos.length > 0) {
        filteredTitleInsights = generateTitleInsights(filteredViralVideos);
      }

      const filteredChannelAnalysis = Array.from(
        new Map(filteredViralVideos.map(v => [v.channelId, v])).values()
      ).map((video: any) => {
        const channelViralVideos = filteredViralVideos.filter(v => v.channelId === video.channelId);
        return {
          channelTitle: video.channelTitle,
          channelCreatedAt: video.channelCreatedAt,
          subscriberCount: video.subscriberCount,
          viralVideoCount: channelViralVideos.length,
          maxViews: Math.max(...channelViralVideos.map(v => v.viewCount)),
          viralVideos: channelViralVideos.map(v => ({
            title: v.title,
            viewCount: v.viewCount,
            videoId: v.videoId,
            publishedAt: v.publishedAt
          })).sort((a, b) => b.viewCount - a.viewCount)
        };
      }).sort((a, b) => b.viralVideoCount - a.viralVideoCount);

      res.json({
        viralPatterns: filteredViralPatterns,
        channelAnalysis: filteredChannelAnalysis,
        titleInsights: filteredTitleInsights,
        summary: {
          totalVideos: searchData.items.length,
          newChannels: filteredChannelAnalysis.length,
          viralVideos: filteredViralVideos.length
        }
      });

    } catch (error: any) {
      console.error("Error analyzing new channels:", error);
      res.status(500).json({ error: error.message || "분석 중 오류가 발생했습니다" });
    }
  });

  // Hybrid analysis: Compare established vs new viral channels
  app.post("/api/hybrid-analysis", async (req: Request, res: Response) => {
    try {
      const { keyword } = req.body;
      
      if (!keyword) {
        return res.status(400).json({ error: "키워드가 필요합니다" });
      }

      console.log(`Hybrid analysis for keyword: ${keyword}`);

      const YOUTUBE_API_KEY = getCurrentYouTubeApiKey();
      if (!YOUTUBE_API_KEY) {
        return res.status(500).json({ 
          error: "사용 가능한 YouTube API 키가 없습니다",
          establishedChannels: [],
          newChannels: [],
          comparison: null
        });
      }

      // Search for videos with the keyword
      const searchUrl = "https://www.googleapis.com/youtube/v3/search";
      const searchParams = new URLSearchParams({
        key: YOUTUBE_API_KEY,
        part: "snippet",
        q: keyword,
        type: "video",
        order: "relevance",
        maxResults: "50",
        regionCode: "KR",
        relevanceLanguage: "ko"
      });

      const searchResponse = await fetch(`${searchUrl}?${searchParams}`);
      const searchData = await searchResponse.json();
      
      if (searchData.error) {
        if (searchData.error.reason === 'quotaExceeded') {
          apiKeyManager.markKeyAsExceeded(YOUTUBE_API_KEY);
          apiKeyManager.switchToNextAvailableKey();
        }
        return res.status(500).json({ error: searchData.error.message });
      }

      if (!searchData.items || searchData.items.length === 0) {
        return res.json({
          establishedChannels: [],
          newChannels: [],
          comparison: { insights: ["검색 결과가 없습니다."] }
        });
      }

      // Get video statistics
      const videoIds = searchData.items.map((item: any) => item.id.videoId).join(",");
      const statsResponse = await fetch(`https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({
        key: YOUTUBE_API_KEY,
        part: "statistics,snippet",
        id: videoIds
      })}`);
      const statsData = await statsResponse.json();

      // Get channel information
      const channelIds = searchData.items.map((item: any) => item.snippet.channelId);
      const uniqueChannelIds = [...new Set(channelIds)].join(",");
      const channelResponse = await fetch(`https://www.googleapis.com/youtube/v3/channels?${new URLSearchParams({
        key: YOUTUBE_API_KEY,
        part: "statistics,snippet",
        id: uniqueChannelIds
      })}`);
      const channelData = await channelResponse.json();

      // Separate established vs new channels
      const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
      const establishedChannels: any[] = [];
      const newChannels: any[] = [];

      // Process all videos and categorize by channel age
      searchData.items.forEach((item: any, index: number) => {
        const stats = statsData.items[index]?.statistics || {};
        const channel = channelData.items.find((ch: any) => ch.id === item.snippet.channelId);
        
        if (!channel) return;

        const channelCreatedAt = new Date(channel.snippet.publishedAt);
        const viewCount = parseInt(stats.viewCount || "0");
        const subscriberCount = parseInt(channel.statistics?.subscriberCount || "0");

        // Only include videos with significant performance
        if (viewCount >= 50000) { // 5만 조회수 이상
          const videoData = {
            videoId: item.id.videoId,
            title: item.snippet.title,
            channelTitle: item.snippet.channelTitle,
            channelId: item.snippet.channelId,
            channelCreatedAt: channelCreatedAt,
            viewCount: viewCount,
            subscriberCount: subscriberCount,
            publishedAt: new Date(item.snippet.publishedAt),
            thumbnailUrl: item.snippet.thumbnails.medium.url,
            description: item.snippet.description,
            ratio: viewCount / (subscriberCount + 1)
          };

          if (channelCreatedAt >= sixMonthsAgo) {
            newChannels.push(videoData);
          } else {
            establishedChannels.push(videoData);
          }
        }
      });

      // Sort by performance
      establishedChannels.sort((a, b) => b.viewCount - a.viewCount);
      newChannels.sort((a, b) => b.viewCount - a.viewCount);

      // Generate comparison analysis using OpenAI
      const comparisonAnalysis = await generateHybridAnalysis(establishedChannels, newChannels, keyword);

      res.json({
        establishedChannels: establishedChannels.slice(0, 10),
        newChannels: newChannels.slice(0, 10),
        comparison: comparisonAnalysis,
        summary: {
          keyword,
          establishedCount: establishedChannels.length,
          newCount: newChannels.length,
          totalAnalyzed: establishedChannels.length + newChannels.length
        }
      });

    } catch (error: any) {
      console.error("Error in hybrid analysis:", error);
      res.status(500).json({ error: error.message || "하이브리드 분석 중 오류가 발생했습니다" });
    }
  });

  // Settings API endpoints for managing YouTube API keys
  
  // Get all API keys
  app.get("/api/settings/api-keys", (req: Request, res: Response) => {
    try {
      const apiKeys = apiKeyManager.getAllKeys().map(key => ({
        id: key.id,
        name: key.name,
        key: `${key.key.substring(0, 10)}...${key.key.substring(key.key.length - 4)}`,
        isActive: key.isActive,
        quotaExceeded: key.quotaExceeded,
        lastChecked: key.lastChecked
      }));
      
      res.json({ apiKeys });
    } catch (error: any) {
      res.status(500).json({ error: "API 키 목록을 가져오는데 실패했습니다" });
    }
  });

  // Add new API key
  app.post("/api/settings/api-keys", (req: Request, res: Response) => {
    try {
      const { name, key } = req.body;
      
      if (!name || !key) {
        return res.status(400).json({ error: "키 이름과 API 키가 필요합니다" });
      }
      
      const id = apiKeyManager.addKey(name.trim(), key.trim());
      res.json({ success: true, id });
    } catch (error: any) {
      res.status(500).json({ error: "API 키 추가에 실패했습니다" });
    }
  });

  // Remove API key
  app.delete("/api/settings/api-keys/:id", (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const success = apiKeyManager.removeKey(id);
      
      if (!success) {
        return res.status(404).json({ error: "API 키를 찾을 수 없습니다" });
      }
      
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "API 키 삭제에 실패했습니다" });
    }
  });

  // Activate API key
  app.post("/api/settings/api-keys/:id/activate", (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const success = apiKeyManager.setActiveKey(id);
      
      if (!success) {
        return res.status(400).json({ error: "API 키를 활성화할 수 없습니다 (할당량 초과됨)" });
      }
      
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "API 키 활성화에 실패했습니다" });
    }
  });

  // Test API key
  app.post("/api/settings/api-keys/:id/test", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const result = await apiKeyManager.testKey(id);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: "API 키 테스트에 실패했습니다" });
    }
  });

  // Switch to next available API key
  app.post("/api/settings/api-keys/switch-next", (req: Request, res: Response) => {
    try {
      const success = apiKeyManager.switchToNextAvailableKey();
      
      if (!success) {
        return res.status(400).json({ error: "사용 가능한 다른 API 키가 없습니다" });
      }
      
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "API 키 전환에 실패했습니다" });
    }
  });

  // Channel viral analysis endpoint
  app.post("/api/analyze-selected-channels-viral", async (req: Request, res: Response) => {
    try {
      const { channelIds, keyword } = req.body;
      
      if (!channelIds || !Array.isArray(channelIds) || channelIds.length === 0) {
        return res.status(400).json({ error: "채널 ID 목록이 필요합니다." });
      }

      console.log(`Analyzing ${channelIds.length} channels for 1M+ view videos...`);
      console.log(`Channel IDs to analyze:`, channelIds);
      
      const channelAnalysisData = [];
      const shoppingChannelData = [];
      const allViralVideos = [];
      const allShoppingVideos = [];

      // Batch process channels to reduce API calls (optimization)
      const batchSize = 5;
      for (let i = 0; i < channelIds.length; i += batchSize) {
        const channelBatch = channelIds.slice(i, i + batchSize);
        
        // Get channel info in batches
        const channelUrl = "https://www.googleapis.com/youtube/v3/channels";
        const channelParams = new URLSearchParams({
          part: "snippet,statistics",
          id: channelBatch.join(",")
        });
        
        const channelData = await makeYouTubeApiRequest(channelUrl, channelParams);
        console.log(`Batch ${Math.floor(i/batchSize) + 1}: Retrieved ${channelData.items?.length || 0} channels`);
        
        for (const channel of channelData.items || []) {
          try {
            const isShoppChannel = isShoppingChannel(channel);
            
            // Get recent videos from the channel
            const searchUrl = "https://www.googleapis.com/youtube/v3/search";
            const searchParams = new URLSearchParams({
              part: "snippet",
              channelId: channel.id,
              type: "video",
              order: "date",
              maxResults: "50", // Get more videos to find viral ones
              publishedAfter: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString() // Last 2 years
            });
            
            const searchData = await makeYouTubeApiRequest(searchUrl, searchParams);
            
            if (!searchData.items || searchData.items.length === 0) {
              console.log(`No videos found for channel ${channel.snippet.title}`);
              continue;
            }
            console.log(`Found ${searchData.items.length} videos for channel ${channel.snippet.title}`);

          // Get video statistics
          const videoIds = searchData.items.map((item: any) => item.id.videoId).join(",");
          const statsUrl = "https://www.googleapis.com/youtube/v3/videos";
          const statsParams = new URLSearchParams({
            part: "statistics,snippet",
            id: videoIds
          });
          
          const statsData = await makeYouTubeApiRequest(statsUrl, statsParams);
          
          // Filter videos with 1M+ views and limit to top 5 per channel
          const allVideos = statsData.items || [];
          console.log(`Channel ${channel.snippet.title}: Found ${allVideos.length} videos`);
          
          const viralVideos = allVideos
            .filter((video: any) => {
              const viewCount = parseInt(video.statistics?.viewCount || "0");
              return viewCount >= 1000000;
            })
            .map((video: any) => ({
              videoId: video.id,
              title: video.snippet.title,
              viewCount: parseInt(video.statistics.viewCount),
              publishedAt: video.snippet.publishedAt,
              thumbnailUrl: video.snippet.thumbnails.medium?.url || video.snippet.thumbnails.default?.url,
              description: (video.snippet.description || "").substring(0, 150) // Limit description
            }))
            .sort((a: any, b: any) => b.viewCount - a.viewCount)
            .slice(0, 5); // Only top 5 viral videos per channel
          
          console.log(`Channel ${channel.snippet.title}: Found ${viralVideos.length} viral videos (1M+ views)`);
          if (viralVideos.length > 0) {
            console.log(`Top viral video: "${viralVideos[0].title}" - ${viralVideos[0].viewCount.toLocaleString()} views`);
          }

            if (viralVideos.length > 0) {
              const channelViralData = {
                channelId: channel.id,
                channelTitle: channel.snippet.title,
                subscriberCount: parseInt(channel.statistics?.subscriberCount || "0"),
                totalViews: parseInt(channel.statistics?.viewCount || "0"),
                viralVideos: viralVideos,
                viralVideoCount: viralVideos.length,
                avgViewsPerViralVideo: viralVideos.reduce((sum: number, v: any) => sum + v.viewCount, 0) / viralVideos.length,
                isShoppingChannel: isShoppChannel
              };
              
              if (isShoppChannel) {
                shoppingChannelData.push(channelViralData);
                allShoppingVideos.push(...viralVideos);
              } else {
                channelAnalysisData.push(channelViralData);
                allViralVideos.push(...viralVideos);
              }
            }
            
          } catch (error) {
            console.error(`Error analyzing channel ${channel.id}:`, error);
            continue;
          }
        }
        
        // Add delay between batches
        if (i + batchSize < channelIds.length) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      // Analyze titles
      const titleAnalysis = await analyzeViralTitles(allViralVideos);
      
      // Analyze thumbnails
      const thumbnailAnalysis = await analyzeThumbnails(allViralVideos);

      // Generate popular title suggestions and content recommendations
      const popularTitles = await generatePopularTitleSuggestions(allViralVideos, titleAnalysis);
      const contentRecommendations = await generateContentRecommendations(allViralVideos, titleAnalysis, thumbnailAnalysis);

      console.log(`Analysis completed - Regular channels: ${channelAnalysisData.length}, Shopping channels: ${shoppingChannelData.length}`);
      console.log(`Total viral videos found: ${allViralVideos.length}, Shopping videos: ${allShoppingVideos.length}`);
      
      const response = {
        channelData: channelAnalysisData,
        shoppingChannelData: shoppingChannelData,
        titleAnalysis,
        thumbnailAnalysis,
        popularTitles,
        contentRecommendations,
        summary: {
          totalChannels: channelAnalysisData.length,
          totalShoppingChannels: shoppingChannelData.length,
          totalViralVideos: allViralVideos.length,
          totalShoppingVideos: allShoppingVideos.length,
          avgViralPerChannel: channelAnalysisData.length > 0 ? allViralVideos.length / channelAnalysisData.length : 0,
          avgShoppingPerChannel: shoppingChannelData.length > 0 ? allShoppingVideos.length / shoppingChannelData.length : 0
        }
      };
      
      console.log("Response summary:", JSON.stringify(response.summary, null, 2));
      res.json(response);

    } catch (error) {
      console.error("Channel viral analysis error:", error);
      res.status(500).json({ error: error.message || "채널 바이럴 분석 중 오류가 발생했습니다." });
    }
  });

  return server;
}

async function generatePopularTitleSuggestions(videos: any[], titleAnalysis: any): Promise<any[]> {
  try {
    if (!videos || videos.length === 0) {
      return [];
    }

    const topVideos = videos.slice(0, 15).map(video => ({
      title: video.title,
      viewCount: video.viewCount,
      description: video.description?.substring(0, 200) || ''
    }));

    const prompt = `
      다음 바이럴 YouTube 영상들의 제목 패턴을 분석하여 인기 있을 새로운 제목 10개를 제안해주세요:

      바이럴 영상 데이터:
      ${JSON.stringify(topVideos, null, 2)}

      제목 분석 결과:
      ${JSON.stringify(titleAnalysis, null, 2)}

      다음 JSON 형식으로 10개의 인기 예상 제목을 제안해주세요:
      {
        "suggestions": [
          {
            "title": "제안 제목",
            "reason": "이 제목이 인기를 끌 것으로 예상하는 이유",
            "pattern": "사용된 패턴 (예: 호기심 유발, 방법 제시, 감정 자극 등)",
            "targetViews": "예상 조회수 범위"
          }
        ]
      }

      - 실제 바이럴 영상들의 패턴을 적용하세요
      - 클릭을 유도하는 호기심 유발 요소를 포함하세요
      - 구체적이고 명확한 메시지를 전달하세요
      - 감정적 반응을 이끌어내는 단어를 사용하세요
    `;

    const response = await openai.chat.completions.create({
      model: "gpt-4o", // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
      messages: [
        {
          role: "system",
          content: "당신은 YouTube 콘텐츠 전략 전문가입니다. 바이럴 영상들의 패턴을 분석하여 인기를 끌 수 있는 새로운 제목을 제안해주세요."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(response.choices[0].message.content || '{"suggestions": []}');
    return result.suggestions || [];
  } catch (error) {
    console.error('Error generating popular titles:', error);
    return [];
  }
}

async function generateContentRecommendations(videos: any[], titleAnalysis: any, thumbnailAnalysis: any): Promise<any[]> {
  try {
    if (!videos || videos.length === 0) {
      return [];
    }

    const contentData = videos.slice(0, 10).map(video => ({
      title: video.title,
      viewCount: video.viewCount,
      description: video.description?.substring(0, 300) || '',
      publishedAt: video.publishedAt
    }));

    const prompt = `
      다음 바이럴 YouTube 영상 데이터와 분석 결과를 바탕으로 새로운 콘텐츠 주제와 제목을 10개 추천해주세요:

      바이럴 영상 데이터:
      ${JSON.stringify(contentData, null, 2)}

      제목 패턴 분석:
      ${JSON.stringify(titleAnalysis, null, 2)}

      썸네일 패턴 분석:
      ${JSON.stringify(thumbnailAnalysis, null, 2)}

      다음 JSON 형식으로 콘텐츠 추천을 제공해주세요:
      {
        "recommendations": [
          {
            "topic": "콘텐츠 주제",
            "title": "추천 제목",
            "description": "콘텐츠 설명 및 구성 요소",
            "targetAudience": "타겟 관객",
            "expectedViews": "예상 조회수 범위",
            "thumbnailTips": "썸네일 제작 팁",
            "contentStructure": "콘텐츠 구성 제안",
            "trendingElements": ["트렌드 요소1", "트렌드 요소2"]
          }
        ]
      }

      요구사항:
      - 분석 결과의 성공 패턴을 적용하세요
      - 현재 트렌드를 반영하세요
      - 실현 가능한 콘텐츠를 제안하세요
      - 구체적인 실행 방안을 포함하세요
    `;

    const response = await openai.chat.completions.create({
      model: "gpt-4o", // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
      messages: [
        {
          role: "system",
          content: "당신은 YouTube 콘텐츠 기획 전문가입니다. 바이럴 영상 분석 결과를 바탕으로 새로운 콘텐츠 아이디어를 제안해주세요."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(response.choices[0].message.content || '{"recommendations": []}');
    return result.recommendations || [];
  } catch (error) {
    console.error('Error generating content recommendations:', error);
    return [];
  }
}