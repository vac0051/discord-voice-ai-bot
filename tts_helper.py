import sys
from gtts import gTTS

def main():
    if len(sys.argv) < 3:
        print("Usage: python tts_helper.py <text> <output_mp3_path>")
        sys.exit(1)
        
    text = sys.argv[1]
    output_path = sys.argv[2]
    
    try:
        tts = gTTS(text=text, lang='ru', slow=False)
        tts.save(output_path)
        print("OK")
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
