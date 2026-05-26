import sys
import os
import traceback

def main():
    if len(sys.argv) < 3:
        print("Usage: python ai_helper.py <prompt> <output_mp3_path>")
        sys.exit(1)
        
    prompt = sys.argv[1]
    output_path = sys.argv[2]
    
    # Пытаемся использовать g4f
    try:
        import g4f
        from g4f.client import Client as G4FClient
    except ImportError:
        print("ERROR: g4f not installed")
        sys.exit(1)
        
    try:
        from gtts import gTTS
    except ImportError:
        print("ERROR: gtts not installed")
        sys.exit(1)
        
    system_prompt = """Ты -- голосовой ИИ-ассистент по Dota 2 в Discord. Тебя зовут "Кирилл".
Тебе задали голосовой вопрос. Ответь кратко (1-3 предложения), по делу, с юмором.
Ты эксперт в Dota 2, знаешь всех героев, мету, стратегии.
Если вопрос не про Доту -- все равно ответь, но можешь пошутить про Доту.

Ответь на русском языке. Будь лаконичным — твой ответ будет озвучен голосом!"""

    try:
        client = G4FClient()
        try:
            response = client.chat.completions.create(
                model=g4f.models.gpt_4o,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt}
                ]
            )
        except Exception:
            response = client.chat.completions.create(
                model=g4f.models.default,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt}
                ]
            )
            
        reply = response.choices[0].message.content.strip()
        if not reply:
            reply = "Хм, нейросеть ничего не ответила."
            
        # Убираем лишние символы для TTS
        reply = reply.replace("**", "").replace("*", "").replace("`", "")
        reply = reply.replace("#", "").replace("- ", "")
        
        # Генерируем аудио
        tts = gTTS(text=reply, lang='ru', slow=False)
        tts.save(output_path)
        
        print("OK")
    except Exception as e:
        print(f"ERROR: {e}")
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
