// Demo script to test transcript extraction with known working videos
import { YoutubeTranscript } from 'youtube-transcript';

const testVideos = [
  'Ks-_Mh1QhMc', // TED Talk
  'jNQXAC9IVRw', // Another TED Talk
  '9bZkp7q19f0', // Khan Academy
  'dQw4w9WgXcQ', // Rick Astley (might have captions)
  'kAeaysn1eoA'  // Test video from search
];

async function testTranscriptExtraction() {
  console.log('Testing transcript extraction on various videos...\n');
  
  for (const videoId of testVideos) {
    console.log(`Testing video: ${videoId}`);
    console.log(`URL: https://www.youtube.com/watch?v=${videoId}`);
    
    try {
      // Try auto-detect first
      const transcript = await YoutubeTranscript.fetchTranscript(videoId);
      
      if (transcript && transcript.length > 0) {
        const text = transcript
          .map(item => item.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        
        console.log(`✅ SUCCESS: Found transcript (${text.length} chars)`);
        console.log(`Sample: "${text.substring(0, 100)}..."`);
        console.log('---\n');
        continue;
      }
    } catch (autoError) {
      console.log('Auto-detect failed, trying specific languages...');
    }
    
    // Try specific languages
    const languages = ['en', 'ko', 'ja', 'es', 'fr', 'de'];
    let found = false;
    
    for (const lang of languages) {
      try {
        const transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang });
        
        if (transcript && transcript.length > 0) {
          const text = transcript
            .map(item => item.text)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          
          console.log(`✅ SUCCESS (${lang}): Found transcript (${text.length} chars)`);
          console.log(`Sample: "${text.substring(0, 100)}..."`);
          found = true;
          break;
        }
      } catch (langError) {
        // Silent fail, try next language
      }
    }
    
    if (!found) {
      console.log('❌ FAILED: No transcript available');
    }
    
    console.log('---\n');
  }
}

testTranscriptExtraction().catch(console.error);