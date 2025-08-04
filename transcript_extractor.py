#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import json
import os
import tempfile
import logging
from pathlib import Path
from typing import Optional, Dict, Any

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

try:
    from youtube_transcript_api import YouTubeTranscriptApi
    from pytube import YouTube
    from faster_whisper import WhisperModel
    from pydub import AudioSegment
    import warnings
    warnings.filterwarnings("ignore")
    
except ImportError as e:
    logger.error(f"Required package not found: {e}")
    sys.exit(1)

# Define custom exceptions for error handling
class TranscriptsDisabled(Exception): pass
class NoTranscriptFound(Exception): pass
class VideoUnavailable(Exception): pass
class TooManyRequests(Exception): pass
class NotTranslatable(Exception): pass

class TranscriptExtractor:
    def __init__(self):
        self.whisper_model = None
        self.temp_dir = tempfile.mkdtemp()
        
    def load_whisper_model(self):
        """Load Whisper model lazily"""
        if self.whisper_model is None:
            try:
                logger.info("Loading Whisper model (base)...")
                self.whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
                logger.info("Whisper model loaded successfully")
            except Exception as e:
                logger.error(f"Failed to load Whisper model: {e}")
                raise e
        return self.whisper_model
    
    def extract_youtube_transcript(self, video_id: str) -> Optional[str]:
        """Extract transcript using YouTube Transcript API"""
        try:
            logger.info(f"Attempting to get transcript for video: {video_id}")
            
            # Try different language codes in order of preference
            language_codes = ['ko', 'en', 'ja', 'zh-cn', 'zh-tw']
            
            for lang in language_codes:
                try:
                    logger.info(f"Trying language: {lang}")
                    transcript_list = YouTubeTranscriptApi.get_transcript(video_id, languages=[lang])
                    
                    if transcript_list:
                        # Combine all transcript segments
                        full_transcript = ' '.join([entry['text'] for entry in transcript_list])
                        logger.info(f"Successfully extracted {lang} transcript: {len(full_transcript)} characters")
                        return full_transcript
                        
                except (NoTranscriptFound, NotTranslatable):
                    continue
                except Exception as e:
                    logger.warning(f"Error getting {lang} transcript: {e}")
                    continue
            
            # Try auto-generated captions
            try:
                logger.info("Trying auto-generated captions...")
                transcript_list = YouTubeTranscriptApi.get_transcript(video_id)
                if transcript_list:
                    full_transcript = ' '.join([entry['text'] for entry in transcript_list])
                    logger.info(f"Successfully extracted auto-generated transcript: {len(full_transcript)} characters")
                    return full_transcript
            except Exception as e:
                logger.warning(f"Auto-generated captions failed: {e}")
            
            logger.info("No transcript found via YouTube Transcript API")
            return None
            
        except TranscriptsDisabled:
            logger.info("Transcripts are disabled for this video")
            return None
        except VideoUnavailable:
            logger.error("Video is unavailable")
            return None
        except TooManyRequests:
            logger.error("Too many requests to YouTube API")
            return None
        except Exception as e:
            logger.error(f"Unexpected error in transcript extraction: {e}")
            return None
    
    def download_audio_from_video(self, video_id: str) -> Optional[str]:
        """Download audio from YouTube video using pytube"""
        try:
            logger.info(f"Downloading audio for video: {video_id}")
            
            url = f"https://www.youtube.com/watch?v={video_id}"
            yt = YouTube(url)
            
            # Get the best audio stream
            audio_stream = yt.streams.filter(only_audio=True, file_extension='mp4').first()
            
            if not audio_stream:
                logger.error("No audio stream found")
                return None
            
            # Download to temporary file
            temp_file = os.path.join(self.temp_dir, f"{video_id}_audio.mp4")
            logger.info(f"Downloading audio to: {temp_file}")
            
            audio_stream.download(output_path=self.temp_dir, filename=f"{video_id}_audio.mp4")
            
            # Convert to WAV for better Whisper compatibility
            wav_file = os.path.join(self.temp_dir, f"{video_id}_audio.wav")
            logger.info("Converting to WAV format...")
            
            audio = AudioSegment.from_file(temp_file)
            audio.export(wav_file, format="wav")
            
            # Clean up original file
            if os.path.exists(temp_file):
                os.remove(temp_file)
            
            logger.info(f"Audio downloaded and converted: {wav_file}")
            return wav_file
            
        except Exception as e:
            logger.error(f"Error downloading audio: {e}")
            return None
    
    def transcribe_audio_with_whisper(self, audio_file: str) -> Optional[str]:
        """Transcribe audio file using Faster Whisper"""
        try:
            logger.info(f"Transcribing audio file: {audio_file}")
            
            model = self.load_whisper_model()
            
            # Transcribe with Korean language preference
            segments, info = model.transcribe(
                audio_file, 
                language="ko",  # Prefer Korean
                beam_size=5,
                best_of=5,
                temperature=0.0,
                condition_on_previous_text=True
            )
            
            logger.info(f"Detected language: {info.language} (probability: {info.language_probability:.2f})")
            
            # Combine all segments
            transcript_parts = []
            for segment in segments:
                transcript_parts.append(segment.text.strip())
            
            full_transcript = ' '.join(transcript_parts).strip()
            
            if full_transcript:
                logger.info(f"Successfully transcribed: {len(full_transcript)} characters")
                return full_transcript
            else:
                logger.warning("Transcription resulted in empty text")
                return None
                
        except Exception as e:
            logger.error(f"Error in Whisper transcription: {e}")
            return None
        finally:
            # Clean up audio file
            if os.path.exists(audio_file):
                try:
                    os.remove(audio_file)
                    logger.info("Cleaned up temporary audio file")
                except:
                    pass
    
    def extract_transcript(self, video_id: str) -> Dict[str, Any]:
        """Main method to extract transcript with fallback"""
        try:
            logger.info(f"Starting transcript extraction for video: {video_id}")
            
            # Step 1: Try YouTube Transcript API first
            transcript = self.extract_youtube_transcript(video_id)
            
            if transcript and len(transcript.strip()) > 50:
                return {
                    "success": True,
                    "transcript": transcript,
                    "method": "youtube_transcript_api",
                    "video_id": video_id
                }
            
            # Step 2: If no transcript available, try audio transcription
            logger.info("No transcript found, attempting audio download and transcription...")
            
            audio_file = self.download_audio_from_video(video_id)
            if not audio_file:
                return {
                    "success": False,
                    "error": "Failed to download audio from video",
                    "video_id": video_id
                }
            
            transcript = self.transcribe_audio_with_whisper(audio_file)
            
            if transcript and len(transcript.strip()) > 20:
                return {
                    "success": True,
                    "transcript": transcript,
                    "method": "whisper_transcription",
                    "video_id": video_id
                }
            else:
                return {
                    "success": False,
                    "error": "Audio transcription failed or produced insufficient content",
                    "video_id": video_id
                }
                
        except Exception as e:
            logger.error(f"Critical error in transcript extraction: {e}")
            return {
                "success": False,
                "error": f"Critical error: {str(e)}",
                "video_id": video_id
            }
    
    def cleanup(self):
        """Clean up temporary files"""
        try:
            import shutil
            if os.path.exists(self.temp_dir):
                shutil.rmtree(self.temp_dir)
                logger.info("Cleaned up temporary directory")
        except Exception as e:
            logger.warning(f"Failed to clean up temp directory: {e}")

def main():
    if len(sys.argv) != 2:
        print(json.dumps({"success": False, "error": "Usage: python transcript_extractor.py <video_id>"}))
        sys.exit(1)
    
    video_id = sys.argv[1]
    
    extractor = TranscriptExtractor()
    try:
        result = extractor.extract_transcript(video_id)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        extractor.cleanup()

if __name__ == "__main__":
    main()