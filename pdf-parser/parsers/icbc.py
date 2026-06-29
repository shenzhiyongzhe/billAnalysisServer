import re
from .base import BaseParser

class IcbcParser(BaseParser):
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
            
        card_match = re.search(r'卡号\s+(\d+)', all_text)
        if card_match:
            card_number = card_match.group(1).strip()
            
        range_match = re.search(r'起止日期：(\d{4}-\d{2}-\d{2})\s*—\s*(\d{4}-\d{2}-\d{2})', all_text)
        if range_match:
            start_date = range_match.group(1).strip()
            end_date = range_match.group(2).strip()
            
        # Process lines
        lines = [l.strip() for l in all_text.split('\n') if l.strip()]
        transactions = []
        current_date = ""
        
        for i, line in enumerate(lines):
            if re.match(r'^\d{4}-\d{2}-\d{2}$', line):
                current_date = line
                continue
                
            time_match = re.match(r'^(\d{2}:\d{2}:\d{2})', line)
            if time_match and current_date:
                # Match ICBC transaction line:
                # Time | ValueDate | TxDate | CardNum | TxType | Curr | Abstract | Opponent | Amount | Balance | Channel
                # E.g.: "12:30:00 2025-06-15 2025-06-15 6222... 消费 CNY 微信支付 腾讯科技 -10.00 990.00 网上渠道"
                pattern = r'^(\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([+-][0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})\s*(.*?)$'
                match = re.match(pattern, line)
                if match:
                    time_val = match.group(1)
                    date_time = f"{current_date} {time_val}"
                    month = current_date[:7]
                    
                    abstract = match.group(7)
                    opponent = match.group(8)
                    amount_str = match.group(9).replace(',', '')
                    amount_val = float(amount_str)
                    
                    type_val = "支出" if amount_val < 0 else "收入"
                    amount = abs(amount_val)
                    
                    channel = match.group(11).strip() if match.group(11) else ""
                    
                    # Deduce counterparty
                    # Original logic uses: channel ? `${abstract}-${channel}` : abstract
                    # But since opponent is also in the columns, we can prefer opponent if it's not '/'
                    cp = opponent if opponent and opponent != "/" else abstract
                    if channel and channel != "/":
                        cp = f"{cp}-{channel}"
                        
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
                "source": "工商银行",
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
