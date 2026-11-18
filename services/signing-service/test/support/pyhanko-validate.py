"""Validates the signatures and time-stamps of a sealed PDF with pyHanko (spike S8, SPK-021).

A second, independent verifier next to OpenSSL: it reads the PDF structure itself, applies the
validation data in the document security store (DSS), and checks the modification level of each
signature. Usage:

    python -I pyhanko-validate.py <folder with root.crt> <sealed.pdf> <B-T|B-LT|B-LTA>

Prints one JSON object per signature. Needs `pyhanko` and `pyhanko-certvalidator` (MIT), which
are NOT dependencies of this repository: install them in a throwaway virtual environment and point
DOCEDIT_PYHANKO_PYTHON at its interpreter.
"""
import json
import os
import sys

from pyhanko.keys import load_cert_from_pemder
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature, validate_pdf_timestamp
from pyhanko.sign.validation.dss import DocumentSecurityStore

pki, path, profile = sys.argv[1], sys.argv[2], sys.argv[3]
root = load_cert_from_pemder(os.path.join(pki, "root.crt"))
with open(path, "rb") as fh:
    reader = PdfFileReader(fh)
    if profile == "B-T":
        from pyhanko_certvalidator import ValidationContext

        context = ValidationContext(trust_roots=[root], allow_fetching=False)
    else:
        dss = DocumentSecurityStore.read_dss(reader)
        context = dss.as_validation_context({"trust_roots": [root]})
    for sig in reader.embedded_signatures:
        kind = str(sig.sig_object.get("/Type"))
        if kind == "/DocTimeStamp":
            status = validate_pdf_timestamp(sig, context)
        else:
            status = validate_pdf_signature(sig, context)
        print(
            json.dumps(
                {
                    "field": sig.field_name,
                    "type": kind,
                    "intact": bool(status.intact),
                    "valid": bool(status.valid),
                    "trusted": bool(status.trusted),
                    "coverage": str(status.coverage),
                    "modification_level": str(getattr(status, "modification_level", None)),
                }
            )
        )
