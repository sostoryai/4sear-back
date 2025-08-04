interface ApiKey {
  id: string;
  name: string;
  key: string;
  isActive: boolean;
  quotaExceeded: boolean;
  lastChecked?: string;
  dailyUsage?: number;
}

class ApiKeyManager {
  private apiKeys: Map<string, ApiKey> = new Map();
  private currentKeyId: string | null = null;

  constructor() {
    // Initialize with all available YouTube API keys from environment
    const apiKeys = [
      { env: 'YOUTUBE_API_KEY', name: '기본 키' },
      { env: 'YOUTUBE_API_KEY_2', name: 'API 키 2' },
      { env: 'YOUTUBE_API_KEY_3', name: 'API 키 3' },
      { env: 'YOUTUBE_API_KEY_4', name: 'API 키 4' }
    ];

    let firstActiveKey: string | null = null;

    apiKeys.forEach(({ env, name }) => {
      const key = process.env[env];
      if (key) {
        const id = env.toLowerCase().replace('_', '-');
        const apiKey: ApiKey = {
          id,
          name,
          key,
          isActive: !firstActiveKey, // First key becomes active
          quotaExceeded: false,
          lastChecked: new Date().toISOString(),
          dailyUsage: 0
        };
        this.apiKeys.set(id, apiKey);
        
        if (!firstActiveKey) {
          firstActiveKey = id;
          this.currentKeyId = id;
        }
      }
    });

    console.log(`Loaded ${this.apiKeys.size} YouTube API keys`);
  }

  getAllKeys(): ApiKey[] {
    return Array.from(this.apiKeys.values());
  }

  getActiveKey(): string | null {
    if (!this.currentKeyId) return null;
    const activeKey = this.apiKeys.get(this.currentKeyId);
    return activeKey?.quotaExceeded ? null : activeKey?.key || null;
  }

  addKey(name: string, key: string): string {
    const id = `key_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newKey: ApiKey = {
      id,
      name,
      key,
      isActive: false,
      quotaExceeded: false,
      lastChecked: new Date().toISOString(),
      dailyUsage: 0
    };
    
    this.apiKeys.set(id, newKey);
    
    // If no active key, make this one active
    if (!this.currentKeyId || !this.getActiveKey()) {
      this.setActiveKey(id);
    }
    
    return id;
  }

  removeKey(id: string): boolean {
    if (!this.apiKeys.has(id)) return false;
    
    this.apiKeys.delete(id);
    
    // If this was the active key, switch to another
    if (this.currentKeyId === id) {
      this.switchToNextAvailableKey();
    }
    
    return true;
  }

  setActiveKey(id: string): boolean {
    const key = this.apiKeys.get(id);
    if (!key || key.quotaExceeded) return false;
    
    // Deactivate current key
    if (this.currentKeyId) {
      const currentKey = this.apiKeys.get(this.currentKeyId);
      if (currentKey) {
        currentKey.isActive = false;
      }
    }
    
    // Activate new key
    key.isActive = true;
    this.currentKeyId = id;
    
    return true;
  }

  markKeyAsExceeded(keyValue: string): void {
    for (const [id, apiKey] of this.apiKeys.entries()) {
      if (apiKey.key === keyValue) {
        apiKey.quotaExceeded = true;
        apiKey.lastChecked = new Date().toISOString();
        
        // If this was the active key, switch to next available
        if (id === this.currentKeyId) {
          this.switchToNextAvailableKey();
        }
        break;
      }
    }
  }

  switchToNextAvailableKey(): boolean {
    const availableKeys = Array.from(this.apiKeys.entries())
      .filter(([_, key]) => !key.quotaExceeded);
    
    if (availableKeys.length === 0) {
      this.currentKeyId = null;
      return false;
    }
    
    // Deactivate current key
    if (this.currentKeyId) {
      const currentKey = this.apiKeys.get(this.currentKeyId);
      if (currentKey) {
        currentKey.isActive = false;
      }
    }
    
    // Activate next available key
    const [nextId, nextKey] = availableKeys[0];
    nextKey.isActive = true;
    this.currentKeyId = nextId;
    
    return true;
  }

  async testKey(id: string): Promise<{ success: boolean; error?: string; quotaInfo?: string }> {
    const apiKey = this.apiKeys.get(id);
    if (!apiKey) {
      return { success: false, error: 'API 키를 찾을 수 없습니다.' };
    }

    try {
      const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${new URLSearchParams({
        part: 'snippet',
        q: 'test',
        type: 'video',
        maxResults: '1',
        key: apiKey.key
      })}`);

      const data = await response.json();
      
      if (data.error) {
        console.log(`API Key ${id} Error Details:`, JSON.stringify(data.error, null, 2));
        if (data.error.reason === 'quotaExceeded') {
          apiKey.quotaExceeded = true;
        }
        apiKey.lastChecked = new Date().toISOString();
        return { success: false, error: data.error.message };
      }

      // Success - reset quota exceeded status
      apiKey.quotaExceeded = false;
      apiKey.lastChecked = new Date().toISOString();
      
      return { 
        success: true, 
        quotaInfo: data.pageInfo?.totalResults ? `검색 가능` : '정상'
      };
    } catch (error) {
      apiKey.lastChecked = new Date().toISOString();
      return { success: false, error: '네트워크 오류가 발생했습니다.' };
    }
  }

  getKeyById(id: string): ApiKey | undefined {
    return this.apiKeys.get(id);
  }

  // Reset quota exceeded status daily (call this from a cron job)
  resetDailyQuotas(): void {
    for (const apiKey of this.apiKeys.values()) {
      apiKey.quotaExceeded = false;
      apiKey.dailyUsage = 0;
      apiKey.lastChecked = new Date().toISOString();
    }
    
    // Reactivate first available key if none is active
    if (!this.currentKeyId) {
      this.switchToNextAvailableKey();
    }
  }
}

export const apiKeyManager = new ApiKeyManager();

// Reset quota status for all keys on startup
apiKeyManager.resetDailyQuotas();