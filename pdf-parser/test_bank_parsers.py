import os
import glob
import pdfplumber
import traceback
from main import detect_source
from parsers.icbc import IcbcParser
from parsers.bocom import BocomParser

uploads_dir = r"d:\Project\uniapp\billAnalysisAssistant\billAnalysisServer\uploads"

# Find all PDF files in uploads
pdf_files = glob.glob(os.path.join(uploads_dir, "*.pdf"))

print(f"Found {len(pdf_files)} PDF files in uploads:")
for pf in pdf_files:
    filename = os.path.basename(pf)
    # Check if the filename contains common bank terms (or garbled versions of them)
    # Let's detect source
    try:
        source = detect_source(pf)
        print(f"File: {filename} -> Detected Source: {source}")
        
        # Extract text to inspect
        with pdfplumber.open(pf) as pdf:
            all_text = ""
            for i, page in enumerate(pdf.pages):
                all_text += f"--- PAGE {i+1} ---\n" + (page.extract_text() or "") + "\n"
            
            # Write to a txt file
            txt_name = filename.replace(".pdf", "_text.txt")
            # Remove invalid chars from name if needed
            txt_path = os.path.join(uploads_dir, txt_name)
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(all_text)
            print(f"  Wrote raw text to: {txt_name}")
            
        # Parse if detected as Icbc or Bocom
        if source == "工商银行":
            print("  Running IcbcParser...")
            parser = IcbcParser(pf)
            result = parser.parse()
            print(f"  Success! Parsed {len(result['transactions'])} transactions.")
            if result['transactions']:
                print(f"  First transaction: {result['transactions'][0]}")
        elif source == "交通银行":
            print("  Running BocomParser...")
            parser = BocomParser(pf)
            result = parser.parse()
            print(f"  Success! Parsed {len(result['transactions'])} transactions.")
            if result['transactions']:
                print(f"  First transaction: {result['transactions'][0]}")
    except Exception as e:
        print(f"  Error processing {filename}:")
        traceback.print_exc()
