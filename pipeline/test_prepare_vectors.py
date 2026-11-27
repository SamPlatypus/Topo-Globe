"""Unit tests for prepare_vectors: roads must join across region edges.

Run: python -m unittest discover -s pipeline -p 'test_*.py' -v

The phone joins neighbouring region files by exact vertex equality, so every
road that crosses a region edge must have at least one vertex that both files
emit with identical grid coordinates.  The hard case is a straight road: the
Douglas-Peucker step drops collinear nodes, so without care each file keeps a
different node near the edge and the two never meet.
"""
import unittest

from prepare_vectors import build_graph, cut_runs

LAT = -37.5
A_BOX = (142.0, -38.0, 143.0, -37.0)   # west region
B_BOX = (143.0, -38.0, 144.0, -37.0)   # east neighbour
ATTR = (8, 0, '', 0)                   # (class, flags, name, sac): a path


def straight_way(lon0, step, n, first_id=1):
    """A perfectly straight east-west way: every interior node is collinear."""
    return [(first_id + k, lon0 + k * step, LAT) for k in range(n)]


def file_vertices(nodes, bbox, keep_edges=True):
    ways = [(ATTR, run) for run in cut_runs(nodes, *bbox)]
    _, chains = build_graph(ways, LAT, bbox if keep_edges else None)
    verts = set()
    ends_outside = []
    W, S, E, N = (round(v * 50000) for v in bbox)
    for ch in chains:
        verts.update(ch['p'])
        for x, y in (ch['p'][0], ch['p'][-1]):
            if not (W <= x <= E and S <= y <= N):
                ends_outside.append((x, y))
    return verts, ends_outside


class EdgeJoinTest(unittest.TestCase):
    def check_join(self, nodes):
        va, outa = file_vertices(nodes, A_BOX)
        vb, outb = file_vertices(nodes, B_BOX)
        self.assertTrue(outa and outb, 'each file should carry a stub across the edge')
        shared = va & vb
        self.assertTrue(shared, 'the two files share no vertex: a route cannot cross this edge')
        # every stub that sticks out of a file must land on the other file's vertices
        # or its own chain must contain a shared vertex (that is what the router needs)
        for x, y in outa:
            self.assertTrue((x, y) in vb or shared)
        for x, y in outb:
            self.assertTrue((x, y) in va or shared)
        return shared

    def test_straight_way_without_node_on_edge(self):
        nodes = straight_way(142.9905, 0.001, 20)       # 142.9905 ... 143.0095, none at 143.0
        shared = self.check_join(nodes)
        # both nodes either side of 143E are kept by both files
        self.assertEqual(shared, {(round(142.9995 * 50000), round(LAT * 50000)), (round(143.0005 * 50000), round(LAT * 50000))})

    def test_straight_way_with_node_on_edge(self):
        nodes = straight_way(142.990, 0.001, 21)        # includes a node exactly on 143.0
        shared = self.check_join(nodes)
        self.assertIn((round(143.0 * 50000), round(LAT * 50000)), shared)

    def test_long_straight_segments(self):
        # a highway with nodes kilometres apart: the crossing segment itself is long
        nodes = straight_way(142.95, 0.0213, 6)
        self.check_join(nodes)

    def test_old_behaviour_failed(self):
        # documents the bug this guards against: without the edge rule a straight
        # road keeps different nodes in the two files and they never meet
        nodes = straight_way(142.9905, 0.001, 20)
        va, _ = file_vertices(nodes, A_BOX, keep_edges=False)
        vb, _ = file_vertices(nodes, B_BOX, keep_edges=False)
        self.assertFalse(va & vb)

    def test_collision_cannot_move_edge_nodes(self):
        # an unrelated node 0.5 m from the boundary node, present only in the west file,
        # must not push the boundary node off its grid cell there
        nodes = straight_way(142.9905, 0.001, 20, first_id=100)
        near = [(1, 142.999504, -37.500004), (2, 142.9, -37.4)]  # same 2e-5 grid cell; first in the old order
        ways_a = [(ATTR, run) for run in cut_runs(near, *A_BOX)] + [(ATTR, run) for run in cut_runs(nodes, *A_BOX)]
        _, chains_a = build_graph(ways_a, LAT, A_BOX)
        stub_end = (round(143.0005 * 50000), round(LAT * 50000))  # the straight way's end outside the west file
        crossing = [ch for ch in chains_a if stub_end in (ch['p'][0], ch['p'][-1])]
        self.assertEqual(len(crossing), 1)
        vb, _ = file_vertices(nodes, B_BOX)
        cell = (round(142.9995 * 50000), round(LAT * 50000))
        self.assertIn(cell, crossing[0]['p'], 'boundary node was nudged off its cell in the west file')
        self.assertIn(cell, vb)


if __name__ == '__main__':
    unittest.main()


# ---------------------------------------------------------------- link ways that join networks
from prepare_vectors import bridge_links, classify_way, classify_link, F_NOFOOT  # noqa: E402

ROAD = (5, 0, 'Road', 0)
TRAIL = (8, 0, 'Trail', 0)
AISLE = (6, 0, 'Car Park', 0)
WALK = (9, 0, '', 0)


def nd(i, dx, dy):
    """node i, dx/dy degrees from 142.5 E 37.5 S"""
    return (i, 142.5 + dx, LAT + dy)


def ids(out):
    return [[n[0] for n in run] for _, run in out]


class LinkBridgeTest(unittest.TestCase):
    def setUp(self):
        # a road, and a trail that starts 60 m beyond the road's end without touching it
        self.road = (ROAD, [nd(1, 0, 0), nd(2, 0.005, 0), nd(3, 0.01, 0)])
        self.trail = (TRAIL, [nd(10, 0.0107, 0), nd(11, 0.015, 0.003), nd(12, 0.02, 0.006)])

    def test_aisle_joins_trail_to_road(self):
        aisle = (AISLE, [nd(3, 0.01, 0), nd(20, 0.0103, -0.0002), nd(21, 0.0106, -0.0002), nd(10, 0.0107, 0)])
        dead_end = (AISLE, [nd(3, 0.01, 0), nd(30, 0.0101, 0.0004), nd(31, 0.0104, 0.0005)])
        sidewalk = (WALK, [nd(2, 0.005, 0), nd(40, 0.006, 0.0001), nd(41, 0.009, 0.0001), nd(3, 0.01, 0)])
        self.assertEqual(ids(bridge_links([self.road, self.trail], [aisle, dead_end, sidewalk], LAT)), [[3, 20, 21, 10]])

    def test_chain_of_links(self):
        a = (AISLE, [nd(3, 0.01, 0), nd(20, 0.0103, -0.0002)])
        b = (WALK, [nd(20, 0.0103, -0.0002), nd(21, 0.0106, -0.0002), nd(10, 0.0107, 0)])
        self.assertEqual(sorted(map(tuple, ids(bridge_links([self.road, self.trail], [a, b], LAT)))), [(3, 20), (20, 21, 10)])

    def test_only_the_shorter_of_two_joins(self):
        short = (AISLE, [nd(3, 0.01, 0), nd(10, 0.0107, 0)])                         # ~60 m
        longer = (WALK, [nd(2, 0.005, 0), nd(50, 0.0065, 0.001), nd(11, 0.015, 0.003)])  # ~900 m
        self.assertEqual(ids(bridge_links([self.road, self.trail], [longer, short], LAT)), [[3, 10]])

    def test_link_beyond_reach_is_not_kept(self):
        far = (WALK, [nd(1, 0, 0), nd(60, 0, -0.01), nd(61, 0.0107, -0.01), nd(10, 0.0107, 0)])  # ~3 km
        self.assertEqual(bridge_links([self.road, self.trail], [far], LAT), [])

    def test_link_to_a_no_foot_way_is_not_kept(self):
        motorway = ((0, F_NOFOOT, 'M1', 0), [nd(70, 0.0107, 0.001), nd(71, 0.03, 0.001)])
        aisle = (AISLE, [nd(3, 0.01, 0), nd(70, 0.0107, 0.001)])
        self.assertEqual(bridge_links([self.road, motorway], [aisle], LAT), [])

    def test_classification(self):
        self.assertIsNone(classify_way({'highway': 'service', 'service': 'parking_aisle'}))
        self.assertIsNotNone(classify_link({'highway': 'service', 'service': 'parking_aisle'}))
        self.assertIsNotNone(classify_link({'highway': 'footway', 'footway': 'sidewalk'}))
        self.assertIsNotNone(classify_link({'highway': 'pedestrian', 'area': 'yes'}))
        self.assertIsNone(classify_link({'highway': 'service', 'service': 'driveway', 'access': 'private'}))
        self.assertIsNone(classify_link({'highway': 'service', 'service': 'drive-through'}))
        self.assertIsNone(classify_link({'highway': 'residential'}))  # a road: kept anyway, not a link
