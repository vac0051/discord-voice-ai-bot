import urllib.request
import zipfile
import os

url = "https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip"
zip_path = "model.zip"
extract_dir = "vosk-model-small-ru-0.22"
final_dir = "model"

print("Downloading model...")
urllib.request.urlretrieve(url, zip_path)
print("Extracting model...")
with zipfile.ZipFile(zip_path, 'r') as zip_ref:
    zip_ref.extractall(".")

print("Renaming folder...")
if os.path.exists(final_dir):
    import shutil
    shutil.rmtree(final_dir)
os.rename(extract_dir, final_dir)

print("Cleaning up...")
os.remove(zip_path)
print("Done!")
