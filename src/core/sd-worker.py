#!/usr/bin/env python3
"""
ClawBrid Stable Diffusion Worker
diffusers 라이브러리 기반 이미지 생성/합성
stdin으로 JSON 명령을 받고 stdout으로 JSON 결과를 반환
모델은 최초 요청 시 로드 후 메모리에 상주
"""
import sys
import json
import os
import time
import base64
import traceback
from pathlib import Path

# 경고 억제
os.environ['TRANSFORMERS_NO_ADVISORY_WARNINGS'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

OUTPUT_DIR = Path.home() / '.clawbrid' / 'temp' / 'images'
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# 전역 파이프라인 (모델 상주)
pipe_txt2img = None
pipe_img2img = None
current_model = None
device = None
dtype = None


def send(msg):
    """JSON 메시지를 stdout으로 전송"""
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def detect_device():
    """GPU/CPU 자동 감지"""
    global device, dtype
    import torch
    if torch.cuda.is_available():
        device = "cuda"
        dtype = torch.float16
        vram = torch.cuda.get_device_properties(0).total_mem / (1024**3)
        gpu_name = torch.cuda.get_device_name(0)
        return {"device": "cuda", "gpu": gpu_name, "vram_gb": round(vram, 1)}
    else:
        device = "cpu"
        dtype = torch.float32
        return {"device": "cpu", "gpu": None, "vram_gb": 0}


def load_model(model_id=None):
    """모델 로드 (최초 1회, 이후 메모리 상주)"""
    global pipe_txt2img, pipe_img2img, current_model
    import torch
    from diffusers import StableDiffusionPipeline, StableDiffusionImg2ImgPipeline

    model_id = model_id or "runwayml/stable-diffusion-v1-5"
    if current_model == model_id and pipe_txt2img is not None:
        return

    send({"status": "loading", "model": model_id, "message": f"모델 로딩 중: {model_id} (최초 실행 시 ~4GB 다운로드)"})

    # txt2img 파이프라인
    pipe_txt2img = StableDiffusionPipeline.from_pretrained(
        model_id,
        torch_dtype=dtype,
        safety_checker=None,
        requires_safety_checker=False,
    ).to(device)

    # 메모리 최적화
    if device == "cuda":
        pipe_txt2img.enable_attention_slicing()

    # img2img 파이프라인 (txt2img 컴포넌트 재사용)
    pipe_img2img = StableDiffusionImg2ImgPipeline(
        vae=pipe_txt2img.vae,
        text_encoder=pipe_txt2img.text_encoder,
        tokenizer=pipe_txt2img.tokenizer,
        unet=pipe_txt2img.unet,
        scheduler=pipe_txt2img.scheduler,
        safety_checker=None,
        feature_extractor=None,
        requires_safety_checker=False,
    )

    current_model = model_id
    send({"status": "model_loaded", "model": model_id})


def make_output_path(prefix="gen"):
    ts = int(time.time() * 1000)
    rand = os.urandom(2).hex()
    return str(OUTPUT_DIR / f"{prefix}_{ts}_{rand}.png")


def image_to_base64(file_path):
    with open(file_path, 'rb') as f:
        return base64.b64encode(f.read()).decode('ascii')


def handle_generate(req):
    """txt2img 이미지 생성"""
    import torch

    load_model(req.get('model'))

    seed = req.get('seed', -1)
    generator = None
    if seed >= 0:
        generator = torch.Generator(device=device).manual_seed(seed)

    result = pipe_txt2img(
        prompt=req.get('prompt', ''),
        negative_prompt=req.get('negative_prompt', '(worst quality, low quality:1.4), blurry, watermark, text'),
        width=req.get('width', 512),
        height=req.get('height', 512),
        num_inference_steps=req.get('steps', 20),
        guidance_scale=req.get('cfg_scale', 7.0),
        generator=generator,
    )

    images = []
    count = min(req.get('batch_size', 1), 4)
    for i, img in enumerate(result.images[:count]):
        out_path = make_output_path("gen")
        img.save(out_path)
        images.append({"path": out_path, "base64": image_to_base64(out_path)})

    return {"images": images}


def handle_edit(req):
    """img2img 이미지 편집/합성"""
    import torch
    from PIL import Image

    load_model(req.get('model'))

    image_path = req.get('image_path')
    if not image_path or not os.path.exists(image_path):
        raise FileNotFoundError(f"이미지 파일을 찾을 수 없습니다: {image_path}")

    width = req.get('width', 512)
    height = req.get('height', 512)
    init_image = Image.open(image_path).convert('RGB').resize((width, height))

    seed = req.get('seed', -1)
    generator = None
    if seed >= 0:
        generator = torch.Generator(device=device).manual_seed(seed)

    result = pipe_img2img(
        prompt=req.get('prompt', ''),
        negative_prompt=req.get('negative_prompt', '(worst quality, low quality:1.4), blurry, watermark'),
        image=init_image,
        strength=req.get('denoising_strength', 0.75),
        guidance_scale=req.get('cfg_scale', 7.0),
        num_inference_steps=req.get('steps', 20),
        generator=generator,
    )

    images = []
    for img in result.images[:1]:
        out_path = make_output_path("edit")
        img.save(out_path)
        images.append({"path": out_path, "base64": image_to_base64(out_path)})

    return {"images": images}


def handle_upscale(req):
    """이미지 업스케일 (PIL 기반)"""
    from PIL import Image

    image_path = req.get('image_path')
    if not image_path or not os.path.exists(image_path):
        raise FileNotFoundError(f"이미지 파일을 찾을 수 없습니다: {image_path}")

    scale = min(req.get('scale', 2), 4)
    img = Image.open(image_path).convert('RGB')
    new_size = (img.width * scale, img.height * scale)
    upscaled = img.resize(new_size, Image.LANCZOS)

    out_path = make_output_path("upscale")
    upscaled.save(out_path)
    return {"path": out_path, "base64": image_to_base64(out_path)}


def handle_status(req):
    """상태 확인"""
    info = detect_device()
    info["model_loaded"] = current_model is not None
    info["current_model"] = current_model
    info["output_dir"] = str(OUTPUT_DIR)

    # 설치된 패키지 확인
    try:
        import diffusers
        info["diffusers_version"] = diffusers.__version__
    except:
        info["diffusers_version"] = None

    try:
        import torch
        info["torch_version"] = torch.__version__
    except:
        info["torch_version"] = None

    return info


def main():
    """메인 루프 - stdin에서 JSON 명령을 읽고 처리"""
    # 초기 상태 전송
    try:
        info = detect_device()
        send({"status": "ready", **info})
    except Exception as e:
        send({"status": "error", "error": f"초기화 실패: {str(e)}"})
        return

    # 명령 루프
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break  # stdin 닫힘
            line = line.strip()
            if not line:
                continue

            req = json.loads(line)
            req_id = req.get('id')
            action = req.get('action', '')

            if action == 'generate':
                result = handle_generate(req)
                send({"id": req_id, **result})

            elif action == 'edit':
                result = handle_edit(req)
                send({"id": req_id, **result})

            elif action == 'upscale':
                result = handle_upscale(req)
                send({"id": req_id, **result})

            elif action == 'status':
                result = handle_status(req)
                send({"id": req_id, **result})

            elif action == 'shutdown':
                send({"id": req_id, "status": "shutdown"})
                break

            else:
                send({"id": req_id, "error": f"알 수 없는 액션: {action}"})

        except json.JSONDecodeError as e:
            send({"error": f"JSON 파싱 실패: {str(e)}"})
        except Exception as e:
            req_id = None
            try:
                req_id = req.get('id')
            except:
                pass
            send({"id": req_id, "error": str(e), "traceback": traceback.format_exc()})


if __name__ == '__main__':
    main()
