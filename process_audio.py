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
    
    # Пытаемся импортировать vosk
    try:
        from vosk import Model, KaldiRecognizer
    except ImportError:
        print("ERROR: vosk not installed")
        sys.exit(1)

    try:
        wf = wave.open(wav_path, "rb")
        if wf.getnchannels() != 1 or wf.getsampwidth() != 2 or wf.getcomptype() != "NONE":
            print("ERROR: Audio file must be WAV format mono PCM.")
            sys.exit(1)
            
        model_path = "/root/botparsecdota2/data/vosk-model-small-ru-0.22"
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
        
        # Проверяем триггер
        trigger = "кирилл"
        if trigger in text.lower() and len(text) > len(trigger):
            # Извлекаем запрос
            idx = text.lower().find(trigger)
            prompt = text[idx + len(trigger):].strip()
            
            if not prompt:
                print("IGNORING: Empty prompt after trigger")
                sys.exit(0)
                
            print(f"TRIGGERED:{prompt}")
            
            # Запускаем генерацию ответа
            try:
                import g4f
                from g4f.client import Client as G4FClient
                from gtts import gTTS
            except ImportError as e:
                print(f"ERROR: missing AI libs: {e}")
                sys.exit(1)
                
            system_prompt = "Ты -- голосовой ИИ-ассистент по Dota 2 в Discord. Тебя зовут Кирилл. Тебе задали вопрос. Ответь кратко (1-3 предложения), по делу, с юмором. Отвечай на русском языке без markdown."
            client = G4FClient()
            
            def is_valid_reply(text):
                """Check if the response is actual text and not HTML/SSE garbage."""
                if not text or not text.strip():
                    return False
                t = text.strip()
                if t.startswith('<!') or t.startswith('<html') or t.startswith('data:') or t.startswith('{'):
                    return False
                if '<html' in t.lower() or '<!doctype' in t.lower():
                    return False
                return True
            
            models_to_try = [g4f.models.gpt_4o_mini, g4f.models.gpt_4o, g4f.models.default]
            
            reply = ""
            for model in models_to_try:
                if reply:
                    break
                for attempt in range(2):
                    try:
                        response = client.chat.completions.create(
                            model=model,
                            messages=[
                                {"role": "system", "content": system_prompt},
                                {"role": "user", "content": prompt}
                            ],
                            stream=False
                        )
                        if hasattr(response, 'choices') and response.choices:
                            raw = response.choices[0].message.content
                            if is_valid_reply(raw):
                                reply = raw.strip()
                                break
                            else:
                                print(f"INVALID_RESPONSE from {model}: {raw[:100]}", file=sys.stderr)
                    except Exception as e:
                        print(f"AI_ERROR model={model} attempt={attempt+1}: {e}", file=sys.stderr)
                    
            if not reply:
                reply = "Хм, нейросеть сегодня молчит. Попробуйте ещё раз!"
                
            reply = reply.replace("**", "").replace("*", "").replace("`", "").replace("#", "").replace("- ", "")
            print(f"REPLY:{reply}")
            
            output_mp3 = wav_path.replace(".wav", "_reply.mp3")
            tts = gTTS(text=reply, lang='ru', slow=False)
            tts.save(output_mp3)
            
            print(f"MP3:{output_mp3}")
            
    except Exception as e:
        print(f"ERROR: {e}")
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
