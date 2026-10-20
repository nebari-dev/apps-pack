"""Extract the PrometheusRule groups from a chart render into a promtool rules file.

Usage: render_prom_rules.py <rendered.yaml> <rules.yaml>

promtool checks the PromQL in the output and runs the alert unit tests in
.github/prometheus/alerts.test.yaml against it.
"""

import sys

import yaml


def main(rendered: str, out: str) -> None:
    docs = [d for d in yaml.safe_load_all(open(rendered)) if d]
    rule = next(d for d in docs if d["kind"] == "PrometheusRule")
    with open(out, "w") as f:
        yaml.safe_dump({"groups": rule["spec"]["groups"]}, f, sort_keys=False)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
