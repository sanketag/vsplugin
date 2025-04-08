# Airflow Coding Standards

## DAG Structure
1. **Imports**: Group in this order:
   - Python standard library
   - Core Airflow
   - Other providers
   - Local modules

2. **Default Arguments**:
```python
default_args = {
    'owner': 'team_name',
    'retries': 3,
    'retry_delay': timedelta(minutes=5),
    'sla': timedelta(hours=1)
}
```

## Task Naming
- Use `snake_case`
- Format: `{module}_{action}`  
  Example: `data_validation_check`

## Error Handling
- Always set `retries` and `sla`
- Use `PythonOperator` only with `@task` decorator
- Log exceptions with context

## Performance
- Avoid XCom for large data (>10KB)
- Use `template_searchpath` for common SQL
- Set `pool` for resource-intensive tasks
