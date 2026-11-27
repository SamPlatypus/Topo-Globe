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
