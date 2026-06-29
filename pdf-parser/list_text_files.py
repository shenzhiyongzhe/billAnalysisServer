import os
import glob

uploads_dir = r"d:\Project\uniapp\billAnalysisAssistant\billAnalysisServer\uploads"
txt_files = glob.glob(os.path.join(uploads_dir, "*_text.txt"))

print("Text files:")
for tf in txt_files:
    print(f"Path: {tf} -> Size: {os.path.getsize(tf)}")
