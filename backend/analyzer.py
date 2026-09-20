"""
SIF Safety Intelligence Platform - AI & Risk Engine Pipeline
Hybrid approach:
1. LLM/NLP extracts safety factors, indicators, and evidence from raw report text.
2. Application Risk Engine applies defined domain criteria to compute risk score, risk level, and priority.
3. Scoring model is isolated in configuration and documented for domain validation.
"""

import os
import json
import re
from typing import Dict, List, Any, Optional
from pydantic import BaseModel, Field

# Prototype risk criteria configuration.
# NOTE: This is a prototype configuration for Oil India Limited (OIL) HSE prototyping.
# Must be formally validated against OIL operational safety matrices before live deployment.
DEFAULT_RISK_CONFIG = {
    "sif_trigger_factors": {
        "gas_leakage": {"weight": 25, "critical_precursor": True},
        "hot_work": {"weight": 20, "critical_precursor": False},
        "confined_space": {"weight": 25, "critical_precursor": True},
        "improper_isolation": {"weight": 25, "critical_precursor": True},
        "working_at_height": {"weight": 20, "critical_precursor": True},
        "electrical_exposure": {"weight": 20, "critical_precursor": True},
        "high_pressure_kick": {"weight": 30, "critical_precursor": True},
        "suspended_load": {"weight": 18, "critical_precursor": False},
        "missing_critical_controls": {"weight": 20, "critical_precursor": True},
        "toxic_h2s_exposure": {"weight": 30, "critical_precursor": True},
    },
    "severity_multipliers": {
        "worker_exposure_present": 1.35,
        "near_miss_with_barrier_failure": 1.25,
        "multiple_compounding_hazards": 1.20
    },
    "thresholds": {
        "critical": 75,
        "high": 50,
        "medium": 25,
        "low": 0
    }
}

class LLMSafetyExtraction(BaseModel):
    report_type: str = Field(description="unsafe_act | unsafe_condition | near_miss | incident | unknown")
    activity: str = Field(default="Not specified")
    equipment: str = Field(default="Not specified")
    location: str = Field(default="Not specified")
    hazards: List[str] = Field(default_factory=list)
    unsafe_acts: List[str] = Field(default_factory=list)
    unsafe_conditions: List[str] = Field(default_factory=list)
    ppe_issues: List[str] = Field(default_factory=list)
    worker_exposure: bool = Field(default=False)
    missing_controls: List[str] = Field(default_factory=list)
    sif_indicators: List[str] = Field(default_factory=list)
    evidence: List[str] = Field(default_factory=list)
    summary: str = Field(default="")
    suggested_actions: List[str] = Field(default_factory=list)

class AnalysisResult(BaseModel):
    report_type: str
    activity: str
    equipment: str
    location: str
    sif_detected: str # YES, NO, REVIEW REQUIRED
    risk_score: int
    risk_level: str # CRITICAL, HIGH, MEDIUM, LOW
    priority_rank: int
    explanation: str
    summary: str
    factors: List[Dict[str, str]]
    worker_exposure: bool
    missing_controls: List[str]
    suggested_actions: List[str]

class SafetyAnalyzer:
    def __init__(self, risk_config: Optional[Dict] = None):
        self.risk_config = risk_config or DEFAULT_RISK_CONFIG
        self.provider = os.getenv("LLM_PROVIDER", "gemini").lower()
        self.model_name = os.getenv("LLM_MODEL", "gemini-3.8-flash")
        self.api_key = os.getenv("GEMINI_API_KEY", "")

    def extract_with_llm(self, report_text: str, filename: str) -> LLMSafetyExtraction:
        """Calls the LLM with structured output schema, falls back to deterministic NLP on failure."""
        if self.api_key and self.provider == "gemini":
            try:
                from google import genai
                from google.genai import types
                client = genai.Client(api_key=self.api_key)

                prompt = f"""You are an expert industrial safety intelligence analyst for Oil India Limited (OIL).
Analyze the following safety observation/near-miss report.
You must extract factual information only. Do NOT hallucinate equipment, injuries, or hazards not in the text.
Use the following safety principle:
- You are a decision-support assistant. Do NOT claim an accident or fatality will definitely happen.
- Identify potential SIF (Serious Injury and Fatality) precursor indicators if high-energy hazards or critical barrier failures exist.

Report Filename: {filename}
Report Text:
\"\"\"
{report_text}
\"\"\"
"""
                response = client.models.generate_content(
                    model=self.model_name,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        response_schema=LLMSafetyExtraction,
                        temperature=0.1,
                    )
                )
                if response.text:
                    parsed = json.loads(response.text)
                    return LLMSafetyExtraction(**parsed)
            except Exception as e:
                print(f"[Analyzer Warning] LLM API call error: {e}. Utilizing fallback deterministic NLP.")

        # Deterministic rule-based extraction fallback
        return self._fallback_nlp_extract(report_text)

    def _fallback_nlp_extract(self, text: str) -> LLMSafetyExtraction:
        """Deterministic safety domain keyword/pattern extraction engine for offline reliability."""
        t_lower = text.lower()

        # Classify report type
        if "near miss" in t_lower or "near-miss" in t_lower:
            rtype = "near_miss"
        elif "unsafe act" in t_lower or "unauthorized" in t_lower or "bypassed" in t_lower or "failure to wear" in t_lower:
            rtype = "unsafe_act"
        elif "unsafe condition" in t_lower or "leak" in t_lower or "corrosion" in t_lower or "damage" in t_lower:
            rtype = "unsafe_condition"
        else:
            rtype = "incident" if "incident" in t_lower else "near_miss"

        hazards = []
        unsafe_acts = []
        unsafe_conds = []
        ppe = []
        missing = []
        sif_ind = []
        evidence = []

        # Gas leak / well kick / pressure
        if any(k in t_lower for k in ["gas leak", "gas leakage", "hydrocarbon", "methane", "gas smell"]):
            hazards.append("Flammable Gas Release")
            sif_ind.append("Potential flammable gas accumulation in working area")
            evidence.append("Text mentions gas leak or presence of combustible hydrocarbons")

        if any(k in t_lower for k in ["kick", "blowout", "high pressure", "wellhead pressure", "pressure surge"]):
            hazards.append("High Pressure Wellbore Fluid / Kick")
            sif_ind.append("Well control barrier challenge or high pressure release")
            evidence.append("Report notes well pressure anomalies or potential kick")

        # Hot work
        if any(k in t_lower for k in ["hot work", "welding", "grinding", "cutting torch", "sparks"]):
            hazards.append("Ignition Source / Hot Work Activity")
            evidence.append("Hot work or open spark generation in operational sector")

        # Working at height
        if any(k in t_lower for k in ["height", "scaffold", "ladder", "derrick", "mast", "monkey board", "fall"]):
            hazards.append("Working at Elevation")
            if any(k in t_lower for k in ["without harness", "unhooked", "no safety belt", "missing toe board", "guardrail"]):
                sif_ind.append("Fall from height risk without positive barrier/arrest")
                unsafe_acts.append("Working at height without verified fall protection")
                evidence.append("Elevation work noted without secure fall arrest system")

        # Confined space & H2S
        if any(k in t_lower for k in ["confined space", "tank entry", "vessel entry", "cellar"]):
            hazards.append("Confined Space Entry")
            sif_ind.append("Restricted atmospheric egress/ventilation risk")

        if any(k in t_lower for k in ["h2s", "hydrogen sulfide", "sour gas"]):
            hazards.append("Toxic Hydrogen Sulfide (H2S)")
            sif_ind.append("Fatal atmospheric toxicity potential")
            evidence.append("H2S presence or alarm reported")

        # Isolation / LOTO
        if any(k in t_lower for k in ["loto", "lockout", "isolation", "not isolated", "energized", "interlock"]):
            if any(k in t_lower for k in ["not isolated", "bypassed", "without lockout", "failed isolation"]):
                missing.append("Positive Isolation / Lockout-Tagout (LOTO)")
                sif_ind.append("Hazardous energy release risk due to compromised isolation")
                evidence.append("Equipment accessed without confirmed de-energization")

        # PPE Issues
        if any(k in t_lower for k in ["no helmet", "no harness", "safety shoes", "safety goggles", "ear protection", "ppe"]):
            if any(k in t_lower for k in ["without", "missing", "damaged", "not worn", "removed"]):
                ppe.append("Inadequate or omitted Personal Protective Equipment")

        # Worker exposure
        worker_exposure = any(k in t_lower for k in [
            "worker", "personnel", "operator", "helper", "crew", "employee", "roughneck", "driller", "technician"
        ])

        # Summary line
        first_line = text.strip().split("\n")[0][:140]

        suggested = []
        if sif_ind:
            suggested.append("Conduct immediate area safety stand-down and verify physical isolation barriers.")
            suggested.append("Audit Permit-to-Work (PTW) validity and gas testing verification logs.")
        else:
            suggested.append("Remind operational personnel of standard operating procedures during toolbox meeting.")

        return LLMSafetyExtraction(
            report_type=rtype,
            activity="Operational Oilfield Activities",
            equipment="Process / Drilling Plant Equipment",
            location="Operational Asset / Wellsite",
            hazards=hazards or ["Operational Hazard"],
            unsafe_acts=unsafe_acts,
            unsafe_conditions=unsafe_conds,
            ppe_issues=ppe,
            worker_exposure=worker_exposure,
            missing_controls=missing,
            sif_indicators=sif_ind,
            evidence=evidence or ["Extracted from report narrative"],
            summary=first_line or "Safety report regarding operational conditions.",
            suggested_actions=suggested
        )

    def assess_risk_and_prioritize(self, extraction: LLMSafetyExtraction, report_text: str) -> AnalysisResult:
        """
        Application Risk Engine:
        Applies configurable safety criteria and transparent math to calculate risk.
        Ensures consistent, reproducible scores and clear human-auditable reasons.
        """
        t_lower = (report_text + " " + " ".join(extraction.hazards) + " " + " ".join(extraction.sif_indicators)).lower()
        score = 15 # Base baseline score

        factors_list = []
        matched_indicators = []
        triggers = self.risk_config["sif_trigger_factors"]

        # Check triggers
        if any(k in t_lower for k in ["gas leak", "gas leakage", "hydrocarbon", "methane", "fuel leak"]):
            score += triggers["gas_leakage"]["weight"]
            factors_list.append({"factor_type": "hazard", "factor_name": "Gas / Hydrocarbon Leakage", "evidence": "Detected gas leak in operational area"})
            matched_indicators.append("Gas leak hazard present")

        if any(k in t_lower for k in ["hot work", "welding", "grinding", "cutting"]):
            score += triggers["hot_work"]["weight"]
            factors_list.append({"factor_type": "hazard", "factor_name": "Hot Work / Ignition Source", "evidence": "Hot work or flame/spark source active"})
            matched_indicators.append("Ignition source in proximity")

        if any(k in t_lower for k in ["confined space", "tank", "vessel entry", "cellar pit"]):
            score += triggers["confined_space"]["weight"]
            factors_list.append({"factor_type": "hazard", "factor_name": "Confined Space Operation", "evidence": "Personnel entry into restricted/enclosed space"})
            matched_indicators.append("Confined space entry")

        if any(k in t_lower for k in ["not isolated", "unisolated", "bypass", "loto", "live circuit", "energized"]):
            score += triggers["improper_isolation"]["weight"]
            factors_list.append({"factor_type": "missing_control", "factor_name": "Inadequate Energy Isolation", "evidence": "Equipment was not positively isolated or locked out"})
            matched_indicators.append("Missing or compromised LOTO")

        if any(k in t_lower for k in ["height", "fall", "scaffold", "derrick", "mast", "monkey board"]):
            score += triggers["working_at_height"]["weight"]
            factors_list.append({"factor_type": "hazard", "factor_name": "Working at Elevation", "evidence": "Elevated work location subject to gravity/fall potential"})
            matched_indicators.append("Elevation hazard")

        if any(k in t_lower for k in ["h2s", "hydrogen sulfide", "sour gas"]):
            score += triggers["toxic_h2s_exposure"]["weight"]
            factors_list.append({"factor_type": "hazard", "factor_name": "Toxic H2S Exposure", "evidence": "Atmospheric hydrogen sulfide risk detected"})
            matched_indicators.append("Toxic gas exposure potential")

        if any(k in t_lower for k in ["high pressure", "kick", "wellbore pressure", "1000 psi", "blowout"]):
            score += triggers["high_pressure_kick"]["weight"]
            factors_list.append({"factor_type": "hazard", "factor_name": "High Pressure Fluid Hazard", "evidence": "Elevated operational line or wellbore pressures noted"})
            matched_indicators.append("High pressure challenge")

        if any(k in t_lower for k in ["suspended load", "crane", "hoist", "rigging", "winch"]):
            score += triggers["suspended_load"]["weight"]
            factors_list.append({"factor_type": "hazard", "factor_name": "Suspended / Overhead Load", "evidence": "Heavy load suspended over work territory"})
            matched_indicators.append("Overhead crane/suspended load")

        # Multipliers
        multipliers = self.risk_config["severity_multipliers"]
        if extraction.worker_exposure:
            score = int(score * multipliers["worker_exposure_present"])
            factors_list.append({"factor_type": "worker_exposure", "factor_name": "Worker Direct Exposure", "evidence": "Personnel were physically located in the line of fire"})

        if len(matched_indicators) >= 2:
            score = int(score * multipliers["multiple_compounding_hazards"])
            factors_list.append({"factor_type": "sif_indicator", "factor_name": "Compounding Multi-Hazard Coincidence", "evidence": f"Simultaneous presence of {len(matched_indicators)} high-severity hazards"})

        # Cap score at 100
        score = min(100, max(5, score))

        # Risk Level & SIF Determination
        thresholds = self.risk_config["thresholds"]
        if score >= thresholds["critical"]:
            risk_level = "CRITICAL"
            sif_detected = "YES"
            priority_rank = 1
        elif score >= thresholds["high"]:
            risk_level = "HIGH"
            sif_detected = "YES" if len(matched_indicators) >= 2 else "REVIEW REQUIRED"
            priority_rank = 2
        elif score >= thresholds["medium"]:
            risk_level = "MEDIUM"
            sif_detected = "REVIEW REQUIRED" if matched_indicators else "NO"
            priority_rank = 3
        else:
            risk_level = "LOW"
            sif_detected = "NO"
            priority_rank = 4

        # Craft human-auditable explanation
        if sif_detected == "YES":
            explanation = (
                f"Potential SIF precursor detected with risk score of {score}/100. "
                f"The report documents critical safety factors including: {', '.join(matched_indicators) if matched_indicators else 'significant energy hazard'}. "
                f"With direct worker exposure and potential barrier failure, this report is prioritized for immediate human safety review."
            )
        elif sif_detected == "REVIEW REQUIRED":
            explanation = (
                f"Requires safety review with risk score of {score}/100. "
                f"Identified hazard factors ({', '.join(matched_indicators) if matched_indicators else 'routine operational conditions'}) warrant verification of existing controls by the safety team."
            )
        else:
            explanation = (
                f"Assessed as low risk ({score}/100) with no immediate SIF precursor indicators detected. "
                f"Standard housekeeping and operational safety controls are recommended."
            )

        # Suggested actions
        suggestions = extraction.suggested_actions or []
        if not suggestions:
            if risk_level in ["CRITICAL", "HIGH"]:
                suggestions = [
                    "Perform immediate on-site safety verification and review Permit to Work (PTW).",
                    "Inspect physical barriers, gas monitoring logs, and isolation tag registers.",
                    "Brief the shift crew during safety toolbox talk regarding identified precursor conditions."
                ]
            else:
                suggestions = [
                    "Follow standard preventive maintenance procedures.",
                    "Log observation in routine safety register."
                ]

        return AnalysisResult(
            report_type=extraction.report_type,
            activity=extraction.activity,
            equipment=extraction.equipment,
            location=extraction.location,
            sif_detected=sif_detected,
            risk_score=score,
            risk_level=risk_level,
            priority_rank=priority_rank,
            explanation=explanation,
            summary=extraction.summary or (report_text[:140] + "..."),
            factors=factors_list,
            worker_exposure=extraction.worker_exposure,
            missing_controls=extraction.missing_controls,
            suggested_actions=suggestions
        )
