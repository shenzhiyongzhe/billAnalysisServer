import re
from .base import BaseParser

class BocomParser(BaseParser):
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
        
        name_match = re.search(r'Account Name:\s*([^\s\n]+)', all_text)
        if name_match:
            name = name_match.group(1).strip()
            
        card_match = re.search(r'\n\s*(\d{10,})', all_text)
        if card_match:
            card_number = card_match.group(1).strip()
            
        # Parse header dates for range
        header_dates = re.findall(r'(\d{4}-\d{2}-\d{2})', all_text)
        query_dates = sorted(list(set(header_dates[:20])))
        if len(query_dates) >= 2:
            start_date = query_dates[0]
            end_date = query_dates[-1]
            
        # Process lines
        raw_lines = all_text.split('\n')
        transactions = []
        
        def try_parse_buffer(raw):
            line = " ".join(raw.split()).strip()
            # Regex matching Bocom transaction pattern:
            # Date CounterParty TxAmount Balance Summary Cr/Dr
            # E.g. "2025-06-04 微信支付-快捷支付 100.00 1200.00 消费 借 Dr"
            pattern = r'^(\d{4}-\d{2}-\d{2})\s+(.+)\s+([0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})\s+(.+?)\s+(贷\s*Cr|借\s*Dr)\s*$'
            match = re.match(pattern, line, re.IGNORECASE)
            if not match:
                return False
                
            date_time = match.group(1)
            counterparty = match.group(2).strip()
            amount = abs(float(match.group(4).replace(',', '')))
            summary = match.group(5).strip()
            dc_flag = match.group(6)
            
            type_val = "收入" if "贷" in dc_flag else "支出"
            
            cp = counterparty if counterparty else (summary if summary else "未知")
            date_only = date_time.split()[0]
            month = date_only[:7]
            
            transactions.append({
                "date": date_time,
                "month": month,
                "type": type_val,
                "amount": amount,
                "counterparty": cp
            })
            return True
            
        def is_skippable(line):
            noise = [
                'Trans Date', '交易日期', 'Bank of Communications', '交通银行个人客户交易清单',
                'Query Result', 'Account Name', 'Account/Card No'
            ]
            return (
                not line or
                line.startswith('--') or
                any(n in line for n in noise) or
                bool(re.match(r'^\d{10,}$', line))
            )
            
        buffer = ""
        for raw_line in raw_lines:
            line = raw_line.strip()
            if is_skippable(line):
                continue
                
            if re.match(r'^\d{4}-\d{2}-\d{2}\s', line):
                if buffer and try_parse_buffer(buffer):
                    buffer = ""
                buffer = line
                if try_parse_buffer(buffer):
                    buffer = ""
                continue
                
            if buffer:
                buffer += " " + line
                if try_parse_buffer(buffer):
                    buffer = ""
                    
        if buffer:
            try_parse_buffer(buffer)
            
        # Sort chronologically, then reverse
        transactions.sort(key=lambda x: x["date"])
        
        if transactions and not start_date:
            start_date = transactions[0]["date"]
        if transactions and not end_date:
            end_date = transactions[-1]["date"]
            
        transactions.reverse()
        
        total_income = sum(t["amount"] for t in transactions if t["type"] == "收入")
        total_expenditure = sum(t["amount"] for t in transactions if t["type"] == "支出")
        
        self.close()
        
        return {
            "summary": {
                "id": "",
                "source": "交通银行",
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
