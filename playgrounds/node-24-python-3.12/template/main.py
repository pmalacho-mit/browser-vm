"""Run me in the terminal: python3 main.py"""
import platform
import sys


def greet(name: str) -> str:
    return f"Hello, {name}, from Python {platform.python_version()} on {platform.machine()}!"


if __name__ == "__main__":
    print(greet(sys.argv[1] if len(sys.argv) > 1 else "world"))
