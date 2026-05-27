import sys
import os
import wave
import json
import traceback

# Force UTF-8 stdout and stderr encoding on Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

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
        if trigger in text.lower():
            # 1. Проверяем голосовую команду на паузу
            pause_keywords = ["пауза", "поставь на паузу", "приостанови"]
            is_pause_request = False
            for keyword in pause_keywords:
                if keyword in text.lower():
                    is_pause_request = True
                    break
            if is_pause_request:
                print("PAUSE:true")
                sys.exit(0)
                
            # 2. Проверяем голосовую команду на возобновление (снятие с паузы)
            resume_keywords = ["продолжи", "продолжить", "сними с паузы", "играй", "запусти"]
            is_resume_request = False
            for keyword in resume_keywords:
                if keyword in text.lower():
                    is_resume_request = True
                    break
            if is_resume_request:
                print("RESUME:true")
                sys.exit(0)
                
            # 3. Проверяем голосовую команду на пропуск трека (скип)
            skip_keywords = ["пропусти", "пропустить", "скип", "скипни", "дальше", "следующий", "следующая"]
            is_skip_request = False
            for keyword in skip_keywords:
                if keyword in text.lower():
                    is_skip_request = True
                    break
            if is_skip_request:
                print("SKIP:true")
                sys.exit(0)

            # 4. Проверяем голосовую команду на автоплей (рекомендации)
            autoplay_keywords = ["включи рекомендации", "рекомендации", "автоплей", "автовоспроизведение"]
            is_autoplay_request = False
            for keyword in autoplay_keywords:
                if keyword in text.lower():
                    is_autoplay_request = True
                    break
            if is_autoplay_request:
                print("AUTOPLAY:true")
                sys.exit(0)

            # 5. Проверяем, это запрос на выключение/остановку музыки полностью
            stop_keywords = ["выключи музыку", "выключи песню", "останови музыку", "выключить музыку", "выключи", "стоп", "останови", "хватит"]
            is_stop_request = False
            for keyword in stop_keywords:
                if keyword in text.lower():
                    is_stop_request = True
                    break
            if is_stop_request:
                print("STOP:true")
                sys.exit(0)
                
            # 5. Проверяем, это запрос на включение музыки
            play_keywords = ["включи музыку", "включить музыку", "включи песню", "поставь песню", "включи", "поставь", "сыграй"]
            is_music_request = False
            music_query = ""
            
            for keyword in play_keywords:
                if keyword in text.lower():
                    # Находим, где этот keyword в тексте, и берем все, что после него
                    idx = text.lower().find(keyword)
                    query_candidate = text[idx + len(keyword):].strip()
                    # Убираем слово "алиса" из поискового запроса, если оно оказалось в конце (например, "включи rammstein алиса")
                    query_candidate_lower = query_candidate.lower()
                    if trigger in query_candidate_lower:
                        trigger_idx = query_candidate_lower.find(trigger)
                        query_candidate = (query_candidate[:trigger_idx] + query_candidate[trigger_idx + len(trigger):]).strip()
                    
                    # Очищаем от знаков препинания в начале/конце
                    query_candidate = query_candidate.strip(",.?! ")
                    
                    if query_candidate:
                        is_music_request = True
                        music_query = query_candidate
                        break
            
            if is_music_request and music_query:
                print(f"MUSIC:{music_query}")
                sys.exit(0)
            else:
                # Если ничего из этого не подошло, но триггер был обнаружен
                print("IGNORING: Empty prompt or unknown command after trigger")
                sys.exit(0)
            
    except Exception as e:
        print(f"ERROR: {e}")
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
