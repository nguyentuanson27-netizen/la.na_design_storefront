"""Run the gflow CLI with the try-on patches installed (see gflow_prompt_guard, gflow_models)."""

from __future__ import annotations

from . import gflow_models, gflow_prompt_guard


def main() -> None:
    gflow_prompt_guard.install()
    gflow_models.install()
    from gflow_cli.cli import main as gflow_main

    gflow_main(prog_name="gflow")


if __name__ == "__main__":
    main()
