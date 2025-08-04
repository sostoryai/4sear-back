import { YoutubeTranscript } from 'youtube-transcript';
import axios from 'axios';

async function extractRealTranscript(videoId) {
  console.log(`Attempting enhanced transcript extraction for: ${videoId}`);
  
  try {
    // Method 1: Try YoutubeTranscript with different language options
    const languages = ['ko', 'en', 'ja', 'zh', 'es', 'fr', 'de', 'auto'];
    
    for (const lang of languages) {
      try {
        console.log(`Trying language: ${lang}`);
        
        let transcript;
        if (lang === 'auto') {
          transcript = await YoutubeTranscript.fetchTranscript(videoId);
        } else {
          transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang });
        }
        
        console.log(`Transcript response for ${lang}:`, transcript ? `${transcript.length} items` : 'null');
        
        if (transcript && transcript.length > 0) {
          console.log(`Processing ${transcript.length} transcript items...`);
          const fullText = transcript
            .map(item => {
              console.log(`Item:`, item);
              return item.text || item.transcript || '';
            })
            .filter(text => text && text.trim())
            .join(' ')
            .replace(/\[.*?\]/g, '') // Remove action descriptions
            .replace(/\(.*?\)/g, '') // Remove sound descriptions
            .replace(/\s+/g, ' ')
            .trim();
          
          console.log(`Processed text length: ${fullText.length}`);
          if (fullText.length > 30) {
            console.log(`Successfully extracted ${lang} transcript: ${fullText.length} characters`);
            return {
              success: true,
              transcript: fullText,
              language: lang,
              method: 'youtube-transcript-api'
            };
          }
        }
      } catch (langError) {
        console.log(`${lang} not available: ${langError.message || 'Unknown error'}`);
        
        // Check if the error message contains available languages
        if (langError.message && langError.message.includes('Available languages:')) {
          const availableLangs = langError.message.match(/Available languages: (.+)/);
          if (availableLangs) {
            console.log(`Found available languages: ${availableLangs[1]}`);
            const langs = availableLangs[1].split(',').map(l => l.trim());
            for (const availLang of langs) {
              if (!languages.includes(availLang)) {
                try {
                  console.log(`Trying discovered language: ${availLang}`);
                  const transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang: availLang });
                  
                  if (transcript && transcript.length > 0) {
                    const fullText = transcript
                      .map(item => item.text)
                      .join(' ')
                      .replace(/\[.*?\]/g, '')
                      .replace(/\(.*?\)/g, '')
                      .replace(/\s+/g, ' ')
                      .trim();
                    
                    if (fullText.length > 30) {
                      console.log(`Successfully extracted ${availLang} transcript: ${fullText.length} characters`);
                      return {
                        success: true,
                        transcript: fullText,
                        language: availLang,
                        method: 'youtube-transcript-api'
                      };
                    }
                  }
                } catch (availError) {
                  console.log(`Available language ${availLang} failed: ${availError.message}`);
                }
              }
            }
          }
        }
      }
    }

    // Method 2: Try without language specification (auto-detect)
    try {
      console.log('Trying auto-detect language...');
      const transcript = await YoutubeTranscript.fetchTranscript(videoId);
      
      if (transcript && transcript.length > 0) {
        const fullText = transcript
          .map(item => item.text)
          .join(' ')
          .replace(/\[.*?\]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        
        if (fullText.length > 50) {
          console.log(`Successfully extracted auto transcript: ${fullText.length} characters`);
          return {
            success: true,
            transcript: fullText,
            language: 'auto',
            method: 'youtube-transcript-api'
          };
        }
      }
    } catch (autoError) {
      console.log('Auto-detect failed');
    }

    // Method 3: Try alternative YouTube internal APIs
    const alternativeUrls = [
      `https://www.youtube.com/api/timedtext?v=${videoId}&fmt=json3&lang=ko`,
      `https://www.youtube.com/api/timedtext?v=${videoId}&fmt=json3&lang=en`,
      `https://www.youtube.com/api/timedtext?v=${videoId}&fmt=json3`,
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=ko&fmt=srv3`,
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=srv3`,
      `https://www.youtube.com/api/timedtext?v=${videoId}&fmt=srv3`
    ];

    for (const url of alternativeUrls) {
      try {
        console.log('Trying alternative API...');
        const response = await axios.get(url, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'application/json,text/xml,application/xml,text/html;q=0.9,text/plain;q=0.8,*/*;q=0.5',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
          }
        });

        if (response.data) {
          let extractedText = '';
          
          // Handle JSON3 format
          if (typeof response.data === 'object' && response.data.events) {
            for (const event of response.data.events) {
              if (event.segs) {
                for (const seg of event.segs) {
                  if (seg.utf8) {
                    extractedText += seg.utf8 + ' ';
                  }
                }
              }
            }
          }
          // Handle SRV3/XML format
          else if (typeof response.data === 'string') {
            const textMatches = response.data.match(/<text[^>]*>(.*?)<\/text>/g);
            if (textMatches) {
              extractedText = textMatches
                .map(match => match.replace(/<[^>]*>/g, ''))
                .join(' ');
            }
          }

          extractedText = extractedText
            .replace(/\[.*?\]/g, '')
            .replace(/\s+/g, ' ')
            .trim();

          if (extractedText.length > 50) {
            console.log(`Successfully extracted via alternative API: ${extractedText.length} characters`);
            return {
              success: true,
              transcript: extractedText,
              language: 'detected',
              method: 'alternative-api'
            };
          }
        }
      } catch (altError) {
        console.log('Alternative API failed, trying next...');
      }
    }

    console.log('All transcript extraction methods failed');
    return {
      success: false,
      error: 'No transcript available for this video',
      method: 'none'
    };

  } catch (error) {
    console.error('Critical error in transcript extraction:', error);
    return {
      success: false,
      error: `Critical error: ${error.message}`,
      method: 'error'
    };
  }
}

// Export for use in main application
export { extractRealTranscript };

// Command line usage
if (process.argv[1]?.endsWith('enhanced-transcript.js')) {
  const videoId = process.argv[2];
  if (!videoId) {
    console.error('Usage: node enhanced-transcript.js <videoId>');
    process.exit(1);
  }

  extractRealTranscript(videoId)
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}