import re
from .base import BaseParser

class SrcbParser(BaseParser):
    def parse(self):
        self.open_pdf()
        
        # Extract text from all pages
        all_text = ""
        for page in self.pdf.pages:
            all_text += (page.extract_text() or "") + "\n"
            
        # Parse summary
        name = "未知"
        card_number = ""
        start_date = ""
        end_date = ""
        
        name_match = re.search(r'户名：(.*?)\s+', all_text)
        if name_match:
            name = name_match.group(1).strip()
            
        card_match = re.search(r'账号\/卡号：(.*?)\s+', all_text)
        if card_match:
            card_number = card_match.group(1).strip()
            
        range_match = re.search(r'起止日期:(.*?)\s+到\s+(.*?)\s+', all_text)
        if range_match:
            start_date = range_match.group(1).strip()
            end_date = range_match.group(2).strip()
            
        # Process lines
        lines = [l.strip() for l in all_text.split('\n') if l.strip()]
        
        blocks = []
        current_block = None
        
        for i, line in enumerate(lines):
            if re.match(r'^\d{4}-\d{2}-\d{2}$', line):
                next_line = lines[i + 1] if i + 1 < len(lines) else ""
                if re.match(r'^\d{2}:\d{2}:\d{2}\b', next_line):
                    if current_block:
                        blocks.append(current_block)
                    current_block = {
                        "date": line,
                        "lines": []
                    }
                    continue
                    
            if current_block:
                skip_keywords = [
                    '广东顺德农村商业银行', '账户/卡明细信息', '起止日期',
                    '交易时间', '————', '累计存入笔数', '总交易笔数', 'END', '打印机构'
                ]
                if any(k in line for k in skip_keywords):
                    continue
                current_block["lines"].append(line)
                
        if current_block:
            blocks.append(current_block)
            
        transactions = []
        
        for block in blocks:
            date_only = block["date"]
            block_text = " ".join(block["lines"])
            
            pattern = r'^(\d{2}:\d{2}:\d{2})\s+(\S+)\s+([+-][0-9,]+\.[0-9]{2})\s+(.*?)$'
            match = re.match(pattern, block_text)
            if match:
                time_val = match.group(1)
                date_time = f"{date_only} {time_val}"
                month = date_only[:7]
                
                amount_str = match.group(3).replace(',', '')
                amount_val = float(amount_str)
                
                type_val = "支出" if amount_val < 0 else "收入"
                amount = abs(amount_val)
                
                remainder = match.group(4).strip()
                
                # Check for balance, channel, summary, etc.
                bal_pattern = r'\s([0-9,]+\.[0-9]{2})\s+(\S+渠道|核心渠道|网上渠道|快捷渠道|自助渠道|柜面渠道|其他渠道)\s+(\S+)\s*(.*?)$'
                bal_match = re.search(bal_pattern, remainder)
                
                if bal_match:
                    balance = bal_match.group(1)
                    channel = bal_match.group(2)
                    summary = bal_match.group(3)
                    memo = bal_match.group(4)
                    
                    # Opponent text is before balance match
                    bal_start_idx = remainder.find(bal_match.group(0))
                    opponent_text = remainder[:bal_start_idx].strip()
                    
                    # Clean opponent: remove numbers (like card/bank accounts) and collapse spaces
                    name_and_bank = re.sub(r'\b\d+(\s+\d+)?\b', '', opponent_text).strip()
                    name_and_bank = " ".join(name_and_bank.split())
                    
                    cp = name_and_bank if name_and_bank else (opponent_text if opponent_text else summary)
                    if channel and channel != '核心渠道':
                        cp = f"{cp} ({channel})"
                else:
                    cp = remainder.split()[0] if remainder else "未知"
                    
                # Clean trailing slashes
                cp = re.sub(r'\s*/\s*$', '', cp).strip()
                if not cp:
                    cp = "未知"
                    
                transactions.append({
                    "date": date_time,
                    "month": month,
                    "type": type_val,
                    "amount": amount,
                    "counterparty": cp
                })
                
        # Sort chronologically, then reverse
        transactions.sort(key=lambda x: x["date"])
        
        if transactions and not start_date:
            start_date = transactions[0]["date"].split()[0]
        if transactions and not end_date:
            end_date = transactions[-1]["date"].split()[0]
            
        transactions.reverse()
        
        total_income = sum(t["amount"] for t in transactions if t["type"] == "收入")
        total_expenditure = sum(t["amount"] for t in transactions if t["type"] == "支出")
        
        self.close()
        
        return {
            "summary": {
                "id": "",
                "source": "农商银行",
                "name": name,
                "idNumber": "",
                "cardNumber": card_number,
                "startDate": start_date,
                "endDate": end_date,
                "totalIncome": round(total_income, 2),
                "totalExpenditure": round(total_expenditure, 2),
                "selfIncome": 0.0,
                "selfExpenditure": 0.0
            },
            "transactions": transactions
        }
