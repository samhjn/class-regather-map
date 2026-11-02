import io
import json
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock

from scripts.fc_manage import maintenance


def api_error(code):
    error = RuntimeError('Synthetic API failure')
    error.code = code
    return error


class MaintenanceCleanupTests(TestCase):
    def setUp(self):
        self.resources = {}
        self.client = Mock(spec=['create_function', 'get_function', 'invoke_function_with_options', 'delete_function'])
        self.client.create_function.side_effect = self.create
        self.client.get_function.side_effect = self.get
        self.client.delete_function.side_effect = self.delete
        self.client.invoke_function_with_options.return_value = SimpleNamespace(
            body=io.BytesIO(json.dumps({'status': 'ok', 'write_read_rollback': True}).encode()))
        self.source = SimpleNamespace(function_name='review-deployment', environment_variables={'SECRET_KEY': 'test-secret'}, vpc_config=None)
        self.log = io.StringIO()

    def create(self, request):
        body = request.body
        self.resources[body.function_name] = SimpleNamespace(description=body.description, state='Active', last_update_status='Successful')

    def get(self, name, request):
        if name not in self.resources:
            raise api_error('FunctionNotFound')
        return SimpleNamespace(body=self.resources[name])

    def delete(self, name):
        if name not in self.resources:
            raise api_error('FunctionNotFound')
        del self.resources[name]

    def run_maintenance(self):
        with redirect_stdout(self.log):
            return maintenance(self.client, self.source, 'test-code', 'bootstrap', {'DJANGO_SUPERUSER_PASSWORD': 'test-password'})

    def test_successful_maintenance_deletes_only_its_temporary_function(self):
        self.assertEqual(self.run_maintenance()['status'], 'ok')
        self.assertFalse(self.resources)
        self.client.delete_function.assert_called_once()
        self.assertEqual(self.log.getvalue(), '')

    def test_create_response_lost_still_finds_and_deletes_the_function(self):
        failure = TimeoutError('response lost')
        def create_then_timeout(request):
            self.create(request)
            raise failure
        self.client.create_function.side_effect = create_then_timeout
        with self.assertRaises(TimeoutError) as caught:
            self.run_maintenance()
        self.assertIs(caught.exception, failure)
        self.assertFalse(self.resources)
        self.client.delete_function.assert_called_once()
        self.assertIn(self.client.create_function.call_args.args[0].body.function_name, self.log.getvalue())
        self.assertNotIn('test-password', self.log.getvalue())

    def test_create_rejected_and_confirmed_absent_preserves_original_error(self):
        failure = api_error('AccessDenied')
        self.client.create_function.side_effect = failure
        with self.assertRaises(RuntimeError) as caught:
            self.run_maintenance()
        self.assertIs(caught.exception, failure)
        self.client.get_function.assert_called_once()
        self.client.delete_function.assert_not_called()

    def test_invocation_failure_still_cleans_up(self):
        self.client.invoke_function_with_options.side_effect = TimeoutError('invocation lost')
        with self.assertRaises(TimeoutError):
            self.run_maintenance()
        self.assertFalse(self.resources)

    def test_creation_conflict_never_deletes_a_differently_owned_function(self):
        def conflict(request):
            self.resources[request.body.function_name] = SimpleNamespace(description='Another operation')
            raise api_error('FunctionAlreadyExists')
        self.client.create_function.side_effect = conflict
        with self.assertRaises(RuntimeError):
            self.run_maintenance()
        self.client.delete_function.assert_not_called()
        self.assertIn('Cleanup unconfirmed', self.log.getvalue())

    def test_cleanup_lookup_failure_keeps_original_error_and_reports_name(self):
        failure = TimeoutError('create response lost')
        self.client.create_function.side_effect = failure
        self.client.get_function.side_effect = api_error('AccessDenied')
        with self.assertRaises(TimeoutError) as caught:
            self.run_maintenance()
        self.assertIs(caught.exception, failure)
        self.assertIn('Cleanup unconfirmed', self.log.getvalue())
        self.assertIn(self.client.create_function.call_args.args[0].body.function_name, self.log.getvalue())
        self.client.delete_function.assert_not_called()

    def test_cleanup_failure_after_success_is_not_reported_as_success(self):
        failure = api_error('AccessDenied')
        self.client.delete_function.side_effect = failure
        with self.assertRaises(RuntimeError) as caught:
            self.run_maintenance()
        self.assertIs(caught.exception, failure)
        self.assertIn('Cleanup unconfirmed', self.log.getvalue())

    def test_already_deleted_function_is_a_successful_cleanup(self):
        def delete_then_not_found(name):
            self.delete(name)
            raise api_error('FunctionNotFound')
        self.client.delete_function.side_effect = delete_then_not_found
        self.assertEqual(self.run_maintenance()['status'], 'ok')
        self.assertFalse(self.resources)
