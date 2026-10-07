"""Distinct recent traffic shapes for disposable website fixtures."""
TRAFFIC_PROFILES = [
    (3, 4, 5, 7, 9, 11, 13),  # Steady growth.
    (13, 11, 9, 7, 5, 4, 3),  # Gradual decline.
    (4, 5, 13, 16, 6, 4, 5),  # A two-day launch.
    (7, 7, 8, 7, 8, 7, 8),  # Stable traffic.
    (3, 12, 4, 13, 5, 11, 4),  # Alternating busy days.
    (12, 8, 4, 2, 4, 8, 12),  # Recovery.
    (3, 4, 5, 18, 6, 4, 3),  # A campaign spike.
    (12, 12, 2, 2, 2, 12, 12),  # Two busy stretches.
    (2, 3, 4, 5, 9, 15, 8),  # Growth followed by a cooldown.
    (9, 6, 0, 0, 3, 7, 11),  # An outage and recovery.
]


def profile_for(site_index):
    return TRAFFIC_PROFILES[site_index % len(TRAFFIC_PROFILES)]
