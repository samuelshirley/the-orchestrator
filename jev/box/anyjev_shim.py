"""A System One wire shim over AnyJev, on 127.0.0.1:8765 behind Caddy.

POST /v1/systemone
  {"model": M, "state": "<text>",
   "questions": {"<key>": {"type": "choice", "instructions": "...", "criteria": {"LABEL": "desc", ...}}}}
200 -> {"model": M, "answers": {"<key>": {"type": "choice", "choice": "LABEL",
                                          "probabilities": {"LABEL": p, ...}}}, "usage": {}}
GET /healthz -> 200 once the model is loaded (setup.sh waits for it).

Only `choice` questions, at AnyJev's zero-label level L0. The choice is always
the argmax of the probabilities returned. UNVERIFIED on a real box: the AnyJev
calls below are the ones the upstream Jev project uses at the same commit.
"""
from __future__ import annotations

import os
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from anyjev import Decider, Question
from anyjev.backends.hf import HFBackend

MODEL = os.environ.get("JEV_HF_MODEL", "Qwen/Qwen3-8B")
MAX_STATE = 20_000
MAX_QUESTIONS = 8
MAX_LABELS = 12

app = FastAPI()
_backend = HFBackend(MODEL, device="cuda", dtype="bfloat16", batch_size=8)
_decider = Decider(_backend, level="L0")


class ChoiceQuestion(BaseModel):
    type: str
    instructions: str = Field(max_length=4000)
    criteria: dict[str, str]


class Request(BaseModel):
    model: str | None = None
    state: str = Field(max_length=MAX_STATE)
    questions: dict[str, ChoiceQuestion]


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "model": MODEL}


@app.post("/v1/systemone")
def systemone(req: Request) -> dict:
    if not req.questions or len(req.questions) > MAX_QUESTIONS:
        raise HTTPException(422, "between 1 and 8 questions")
    started = time.time()
    answers: dict = {}
    for key, q in req.questions.items():
        labels = list(q.criteria)
        if q.type != "choice" or not 2 <= len(labels) <= MAX_LABELS:
            raise HTTPException(422, f"{key}: only choice questions with 2-12 labels")
        text = q.instructions + "\n" + "\n".join(f"{label}: {desc}" for label, desc in q.criteria.items())
        question = Question.choice(text, labels, name=key)
        decision = _decider.decide_batch([req.state], question, level="L0")[0]
        probs = [float(p) for p in decision.probs]
        best = max(range(len(labels)), key=lambda i: probs[i])
        answers[key] = {
            "type": "choice",
            "choice": labels[best],
            "probabilities": dict(zip(labels, probs)),
        }
    return {"model": MODEL, "answers": answers, "usage": {"latency_ms": round((time.time() - started) * 1000)}}
