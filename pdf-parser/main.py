import os
import tempfile
import logging
from typing import Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pdf-parser")

# Import parsers
from parsers.wechat import WechatParser
from parsers.alipay import AlipayParser
from parsers.cmb import CmbParser
from parsers.bocom import BocomParser
from parsers.icbc import IcbcParser
from parsers.srcb import SrcbParser

app = FastAPI(title="PDF statement Parser API", version="1.0.0")

def detect_source(file_path: str, password: Optional[str] = None) -> str:
    import pdfplumber
    try:
        if password:
            pdf = pdfplumber.open(file_path, password=password)
        else:
            pdf = pdfplumber.open(file_path)
            
        first_page = pdf.pages[0]
        text = first_page.extract_text() or ""
        pdf.close()
        
        header_text = text[:2000]
        logger.info(f"Detecting source, header text length: {len(header_text)}")
        
        if "微信支付交易明细证明" in header_text:
            return "微信"
        if "招商银行交易流水" in header_text:
            return "招商银行"
        if "交通银行个人客户交易清单" in header_text:
            return "交通银行"
        if "中国工商银行借记账户历史明细" in header_text:
            return "工商银行"
        if "农村商业银行股份有限公司" in header_text and "账户/卡明细信息" in header_text:
            return "农商银行"
        if "支付宝支付科技有限公司" in header_text and "交易流水证明" in header_text:
            return "支付宝"
            
        return "未知"
    except Exception as e:
        # Check if password exception
        err_msg = str(e).lower()
        if "password" in err_msg or "decrypted" in err_msg:
            raise ValueError("PasswordRequired")
        raise e

@app.post("/parse")
async def parse_pdf(
    file: UploadFile = File(...),
    password: Optional[str] = Form(None)
):
    logger.info(f"Received parse request for file: {file.filename}")
    
    # Save upload file to temporary file
    temp_dir = tempfile.gettempdir()
    temp_path = os.path.join(temp_dir, f"upload_{file.filename}")
    
    try:
        with open(temp_path, "wb") as f:
            content = await file.read()
            f.write(content)
            
        # Detect source
        try:
            source = detect_source(temp_path, password=password)
        except ValueError as ve:
            if str(ve) == "PasswordRequired":
                logger.warn("PDF password required for detection")
                return JSONResponse(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    content={"error": "PasswordRequired", "message": "PDF is password protected."}
                )
            raise ve
            
        logger.info(f"Detected statement source: {source}")
        
        if source == "未知":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="不支持的账单格式，请上传正确的微信、支付宝、招商银行、交通银行、工商银行或农商银行交易流水。"
            )
            
        # Select parser
        parser_map = {
            "微信": WechatParser,
            "支付宝": AlipayParser,
            "招商银行": CmbParser,
            "交通银行": BocomParser,
            "工商银行": IcbcParser,
            "农商银行": SrcbParser
        }
        
        parser_cls = parser_map[source]
        parser = parser_cls(temp_path, password=password)
        
        try:
            result = parser.parse()
            return result
        except ValueError as ve:
            if str(ve) == "PasswordRequired":
                logger.warn("PDF password required for parsing")
                return JSONResponse(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    content={"error": "PasswordRequired", "message": "PDF is password protected."}
                )
            raise ve
            
    except Exception as e:
        logger.error(f"Error parsing PDF: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"解析失败: {str(e)}"
        )
    finally:
        # Clean up temporary file
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception as ex:
                logger.error(f"Failed to remove temp file: {str(ex)}")

class ParsePathRequest(BaseModel):
    filePath: str
    password: Optional[str] = None

@app.post("/parse-path")
async def parse_pdf_path(request: ParsePathRequest):
    logger.info(f"Received parse path request for file: {request.filePath}")
    
    uploads_dir = os.getenv("UPLOADS_DIR", "/app/uploads")
    # Prevent path traversal
    safe_filename = os.path.basename(request.filePath)
    file_path = os.path.join(uploads_dir, safe_filename)
    
    if not os.path.exists(file_path):
        logger.error(f"File not found at path: {file_path}")
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"文件不存在: {safe_filename}"
        )
        
    try:
        # Detect source
        try:
            source = detect_source(file_path, password=request.password)
        except ValueError as ve:
            if str(ve) == "PasswordRequired":
                logger.warn("PDF password required for detection")
                return JSONResponse(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    content={"error": "PasswordRequired", "message": "PDF is password protected."}
                )
            raise ve
            
        logger.info(f"Detected statement source: {source}")
        
        if source == "未知":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="不支持的账单格式，请上传正确的微信、支付宝、招商银行、交通银行、工商银行或农商银行交易流水。"
            )
            
        parser_map = {
            "微信": WechatParser,
            "支付宝": AlipayParser,
            "招商银行": CmbParser,
            "交通银行": BocomParser,
            "工商银行": IcbcParser,
            "农商银行": SrcbParser
        }
        
        parser_cls = parser_map[source]
        parser = parser_cls(file_path, password=request.password)
        
        try:
            result = parser.parse()
            return result
        except ValueError as ve:
            if str(ve) == "PasswordRequired":
                logger.warn("PDF password required for parsing")
                return JSONResponse(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    content={"error": "PasswordRequired", "message": "PDF is password protected."}
                )
            raise ve
            
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Error parsing PDF path: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"解析失败: {str(e)}"
        )

@app.get("/health")
def health_check():
    return {"status": "ok"}
