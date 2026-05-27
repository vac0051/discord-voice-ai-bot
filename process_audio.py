import sys
import os
import wave
import json
import traceback

def main():
    if len(sys.argv) < 2:
        print("Usage: python process_audio.py <path_to_wav>")
        sys.exit(1)
        
    wav_path = sys.argv[1]
    
    try:
        from vosk import Model, KaldiRecognizer, SetLogLevel
        SetLogLevel(-1)
    except ImportError:
        print("ERROR: vosk not installed")
        sys.exit(1)

    try:
        wf = wave.open(wav_path, "rb")
        if wf.getnchannels() != 1 or wf.getsampwidth() != 2 or wf.getcomptype() != "NONE":
            print("ERROR: Audio file must be WAV format mono PCM.")
            sys.exit(1)
            
        model_path = os.path.join(os.path.dirname(__file__), "model")
        if not os.path.exists(model_path):
            print(f"ERROR: Vosk model not found at {model_path}")
            sys.exit(1)
            
        model = Model(model_path)
        rec = KaldiRecognizer(model, wf.getframerate())
        rec.SetWords(True)

        results = []
        while True:
            data = wf.readframes(4000)
            if len(data) == 0:
                break
            if rec.AcceptWaveform(data):
                res = json.loads(rec.Result())
                if 'text' in res and res['text']:
                    results.append(res['text'])
                    
        res = json.loads(rec.FinalResult())
        if 'text' in res and res['text']:
            results.append(res['text'])

        text = " ".join(results).strip()
        print(f"TEXT:{text}")
        
        # Проверяем триггер Алиса
        trigger = "алиса"
        if trigger in text.lower() and len(text) > len(trigger):
            idx = text.lower().find(trigger)
            prompt = text[idx + len(trigger):].strip()
            
            if not prompt:
                print("IGNORING: Empty prompt after trigger")
                sys.exit(0)
                
            print(f"TRIGGERED:{prompt}")
            
            # Проверяем, это запрос на включение музыки
            play_keywords = ["включи музыку", "включи", "поставь", "сыграй"]
            is_music_request = False
            music_query = ""
            
            for keyword in play_keywords:
                if prompt.lower().startswith(keyword):
                    is_music_request = True
                    music_query = prompt[len(keyword):].strip()
                    break
                    
            if is_music_request and music_query:
                print(f"MUSIC:{music_query}")
                sys.exit(0)
            else:
                # Нейросеть отключена, игнорируем любые другие запросы к Алисе
                print("IGNORING: Not a music request, and neural network is disabled.")
                sys.exit(0)
            
    except Exception as e:
        print(f"ERROR: {e}")
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
