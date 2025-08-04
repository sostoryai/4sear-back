// Age group analysis based on content characteristics
function analyzeAgeGroupPreferences(videos: any[]) {
  const ageGroups = {
    '10대': { keywords: ['게임', '아이돌', '댄스', '챌린지', 'tiktok', '숏츠', '밈', '트렌드', 'k팝', '학교', '친구'], videos: [] as any[], score: 0 },
    '20대': { keywords: ['브이로그', '일상', '연애', '취업', '대학', '패션', '뷰티', '카페', '맛집', '여행', '인플루언서'], videos: [] as any[], score: 0 },
    '30대': { keywords: ['결혼', '육아', '부모', '직장', '투자', '부동산', '건강', '운동', '요리', '리뷰', '정보'], videos: [] as any[], score: 0 },
    '40대': { keywords: ['자녀교육', '가족', '건강관리', '투자', '재테크', '부동산', '골프', '등산', '여행', '정치'], videos: [] as any[], score: 0 },
    '50대': { keywords: ['건강', '운동', '등산', '골프', '정치', '경제', '뉴스', '의료', '보험', '연금', '은퇴'], videos: [] as any[], score: 0 },
    '60대': { keywords: ['건강', '의료', '정치', '뉴스', '종교', '전통', '역사', '클래식', '등산', '낚시'], videos: [] as any[], score: 0 },
    '70대': { keywords: ['건강', '의료', '뉴스', '정치', '종교', '전통음악', '역사', '다큐멘터리', '건강식품'], videos: [] as any[], score: 0 }
  };

  const ageGroupKeys = ['10대', '20대', '30대', '40대', '50대', '60대', '70대'] as const;

  // Analyze each video and assign age group scores
  videos.forEach(video => {
    const title = video.title.toLowerCase();
    const category = video.categoryName;
    
    ageGroupKeys.forEach(ageGroup => {
      let score = 0;
      
      // Check keyword matches
      ageGroups[ageGroup].keywords.forEach((keyword: string) => {
        if (title.includes(keyword)) {
          score += 2;
        }
      });
      
      // Category-based scoring
      if (category === '음악' && (ageGroup === '10대' || ageGroup === '20대')) score += 3;
      if (category === '게임' && (ageGroup === '10대' || ageGroup === '20대')) score += 4;
      if (category === '엔터테인먼트' && (ageGroup === '20대' || ageGroup === '30대')) score += 2;
      if (category === '뉴스/정치' && (ageGroup === '40대' || ageGroup === '50대' || ageGroup === '60대')) score += 3;
      if (category === '스포츠' && (ageGroup === '30대' || ageGroup === '40대')) score += 2;
      
      // View count consideration (younger demographics prefer viral content)
      if (video.viewCount > 10000000 && (ageGroup === '10대' || ageGroup === '20대')) score += 1;
      if (video.viewCount < 1000000 && (ageGroup === '50대' || ageGroup === '60대' || ageGroup === '70대')) score += 1;
      
      if (score > 0) {
        ageGroups[ageGroup].videos.push({
          ...video,
          relevanceScore: score
        });
        ageGroups[ageGroup].score += score;
      }
    });
  });

  // Sort videos within each age group by relevance score
  ageGroupKeys.forEach(ageGroup => {
    ageGroups[ageGroup].videos.sort((a: any, b: any) => b.relevanceScore - a.relevanceScore);
    ageGroups[ageGroup].videos = ageGroups[ageGroup].videos.slice(0, 10); // Top 10 per age group
  });

  return ageGroups;
}

export async function getTrendingTopics() {
  try {
    console.log('Fetching trending topics from YouTube API...');
    
    // Get trending videos from multiple categories
    const categories = [
      { id: '0', name: '전체' },
      { id: '10', name: '음악' },
      { id: '17', name: '스포츠' },
      { id: '20', name: '게임' },
      { id: '22', name: '인물/블로그' },
      { id: '24', name: '엔터테인먼트' },
      { id: '25', name: '뉴스/정치' },
      { id: '28', name: '과학기술' }
    ];

    const trendingVideos: any[] = [];
    const keywordCount: { [key: string]: number } = {};
    const channelCount: { [key: string]: number } = {};

    // Define stop words to filter out during counting
    const stopWords = new Set([
      // English common words
      'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 
      'from', 'up', 'about', 'into', 'through', 'during', 'before', 'after', 'above', 
      'below', 'between', 'among', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could',
      'can', 'may', 'might', 'must', 'shall', 'this', 'that', 'these', 'those',
      'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
      'my', 'your', 'his', 'her', 'its', 'our', 'their', 'mine', 'yours', 'hers', 'ours',
      'theirs', 'a', 'an', 'as', 'if', 'when', 'where', 'why', 'how', 'what', 'which',
      'who', 'whom', 'whose', 'all', 'any', 'both', 'each', 'few', 'more', 'most',
      'other', 'some', 'such', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
      'just', 'now', 'here', 'there', 'then', 'not', 'no', 'yes', 'well', 'also',
      'still', 'again', 'back', 'down', 'out', 'off', 'over', 'under', 'get', 'go',
      'make', 'take', 'come', 'give', 'look', 'see', 'know', 'think', 'feel', 'want',
      'need', 'try', 'use', 'work', 'call', 'ask', 'turn', 'move', 'live', 'play',
      'seem', 'show', 'hear', 'leave', 'put', 'say', 'tell', 'talk', 'become',
      // Generic YouTube terms
      'shorts', 'short', 'video', 'videos', 'youtube', 'subscribe', 'like', 'comment',
      'share', 'playlist', 'channel', 'live', 'stream', 'streaming', 'watch', 'view',
      'views', 'trending', 'viral', 'popular', 'hot', 'new', 'latest', 'best', 'top',
      'first', 'last', 'final', 'episode', 'part', 'full', 'complete', 'official',
      'music', 'song', 'mv', 'teaser', 'trailer', 'behind', 'making', 'interview',
      'reaction', 'review', 'compilation', 'highlight', 'clip', 'cut', 'edit',
      // Time and numbers
      '2024', '2025', '2026', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug',
      'sep', 'oct', 'nov', 'dec', 'january', 'february', 'march', 'april', 'june',
      'july', 'august', 'september', 'october', 'november', 'december', 'today',
      'yesterday', 'tomorrow', 'week', 'month', 'year', 'day', 'time', 'hour',
      'minute', 'second', 'am', 'pm', 'morning', 'afternoon', 'evening', 'night',
      // Generic descriptors
      'big', 'small', 'large', 'huge', 'tiny', 'long', 'short', 'high', 'low',
      'good', 'bad', 'great', 'amazing', 'awesome', 'cool', 'nice', 'beautiful',
      'ugly', 'pretty', 'cute', 'funny', 'sad', 'happy', 'angry', 'excited',
      'boring', 'interesting', 'crazy', 'weird', 'strange', 'normal', 'special',
      'important', 'serious', 'real', 'fake', 'true', 'false', 'right', 'wrong',
      'easy', 'hard', 'difficult', 'simple', 'complex', 'free', 'paid', 'cheap',
      'expensive', 'old', 'young', 'fast', 'slow', 'quick', 'loud', 'quiet',
      // Korean common words
      '그', '이', '저', '의', '에', '를', '을', '가', '이', '은', '는', '와', '과',
      '로', '으로', '에서', '부터', '까지', '만', '도', '조차', '마저', '라', '이라',
      '아', '야', '어', '여', '지', '죠', '네', '요', '습니다', '입니다', '합니다',
      '됩니다', '있습니다', '없습니다', '그리고', '그런데', '하지만', '그러나',
      '또한', '또', '역시', '아직', '벌써', '이미', '드디어', '마침내', '결국',
      '사실', '정말', '진짜', '참', '아주', '매우', '너무', '정말로', '진짜로',
      '완전', '완전히', '전혀', '별로', '거의', '조금', '약간', '살짝', '좀',
      '많이', '적게', '크게', '작게', '높게', '낮게', '빠르게', '천천히',
      '글로벌', '레전드', 'prod', 'big', 'official'
    ]);

    // Fetch trending videos from key categories
    for (const category of categories.slice(0, 6)) {
      try {
        const response = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=KR&videoCategoryId=${category.id}&maxResults=20&key=${process.env.YOUTUBE_API_KEY}`
        );

        if (response.ok) {
          const data = await response.json();
          
          for (const video of data.items || []) {
            trendingVideos.push({
              title: video.snippet.title,
              channelTitle: video.snippet.channelTitle,
              categoryName: category.name,
              viewCount: parseInt(video.statistics.viewCount || '0'),
              publishedAt: video.snippet.publishedAt
            });

            // Count keywords from titles with filtering applied during counting
            const titleWords = video.snippet.title
              .replace(/[^\w\s가-힣]/g, '')
              .toLowerCase()
              .split(/\s+/)
              .filter((word: string) => {
                // Apply all filters during counting to prevent noise
                if (word.length < 2) return false;
                if (stopWords.has(word)) return false;
                if (/^\d+$/.test(word)) return false;
                if (word.replace(/[^\w가-힣]/g, '').length < 2) return false;
                return true;
              });

            titleWords.forEach((word: string) => {
              keywordCount[word] = (keywordCount[word] || 0) + 1;
            });

            // Count channels
            if (video.snippet.channelTitle) {
              channelCount[video.snippet.channelTitle] = (channelCount[video.snippet.channelTitle] || 0) + 1;
            }
          }
        }
      } catch (categoryError) {
        console.log(`Failed to fetch category ${category.name}:`, categoryError);
      }
    }

    // Analyze trending keywords - now with clean data
    const topKeywords = Object.entries(keywordCount)
      .filter(([word, count]) => count >= 3 && word.length >= 2)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 15)
      .map(([word, count]) => ({ keyword: word, count }));

    // Analyze trending channels
    const topChannels = Object.entries(channelCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 12)
      .map(([channel, count]) => ({ channel, count }));

    // Category analysis
    const categoryStats = categories.map(cat => {
      const categoryVideos = trendingVideos.filter(v => v.categoryName === cat.name);
      const totalViews = categoryVideos.reduce((sum, v) => sum + v.viewCount, 0);
      return {
        category: cat.name,
        videoCount: categoryVideos.length,
        totalViews,
        averageViews: categoryVideos.length > 0 ? Math.round(totalViews / categoryVideos.length) : 0
      };
    }).filter(stat => stat.videoCount > 0)
      .sort((a, b) => b.totalViews - a.totalViews);

    // Generate insights
    const insights = [];
    if (topKeywords.length > 0) {
      insights.push(`🔥 가장 인기 키워드: "${topKeywords[0].keyword}" (${topKeywords[0].count}회 등장)`);
    }
    if (topChannels.length > 0) {
      insights.push(`📺 가장 활발한 채널: ${topChannels[0].channel} (${topChannels[0].count}개 영상)`);
    }
    if (categoryStats.length > 0) {
      insights.push(`🎯 가장 인기 카테고리: ${categoryStats[0].category} (총 ${categoryStats[0].totalViews.toLocaleString()} 조회수)`);
    }

    const emergingKeywords = topKeywords.slice(3, 8).map(k => k.keyword);
    if (emergingKeywords.length > 0) {
      insights.push(`🚀 떠오르는 키워드: ${emergingKeywords.join(', ')}`);
    }

    // Perform age group analysis
    const ageGroupAnalysis = analyzeAgeGroupPreferences(trendingVideos);

    return {
      summary: {
        totalVideos: trendingVideos.length,
        analysisDate: new Date().toISOString(),
        period: '이번주 트렌딩 분석'
      },
      topKeywords,
      topChannels,
      categoryStats,
      insights,
      ageGroups: ageGroupAnalysis
    };

  } catch (error) {
    console.error('Trending analysis error:', error);
    throw new Error('Failed to analyze trending topics');
  }
}