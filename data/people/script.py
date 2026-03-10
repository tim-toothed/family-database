import os

for n in range(1, 54):
    filename = f"P{n:03}.yaml"   # P001.yaml ... P053.yaml
    if not os.path.exists(filename):
        with open(filename, "w") as f:
            pass  # creates empty file
        print(f"Created {filename}")
    else:
        print(f"Skipped existing {filename}")