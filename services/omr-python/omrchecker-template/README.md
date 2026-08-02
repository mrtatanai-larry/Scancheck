This folder contains the active OMRChecker master template used by ScanCheck.

Files required:
- `template.json`
- `config.json`
- `omr_marker.jpg` (optional; required only if your template uses `CropOnMarkers`)

Current files are bootstrap defaults and must be recalibrated for your final PCC sheet using OMRChecker `--setLayout`.

Runtime calibration now takes priority from:
- `.runtime/omr-calib/input/template.json`
- `.runtime/omr-calib/input/config.json`
- `.runtime/omr-calib/input/templates.json`

`templates.json` lets you register multiple calibrated layouts (for example 25, 30, 100 questions).  
Each template entry should point to a calibrated `templateFile` in the same folder or an absolute path.
